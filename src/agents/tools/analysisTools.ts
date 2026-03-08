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
import { invoke } from '@tauri-apps/api/core';
import type { AnalysisBundle, AnalysisOptions, EditingStyleDocument } from '@/bindings';
import {
  getAssetCatalogSnapshot,
  getAssetSnapshotById,
  getUnusedAssets,
  getTimelineSnapshot,
  getClipById,
  getTrackById,
  getAllClipsOnTrack,
  getClipsAtTime,
  findClipsByAsset,
  findGaps,
  findOverlaps,
  getWorkspaceFiles,
  getUnregisteredWorkspaceFiles,
  findWorkspaceFile,
} from './storeAccessor';
import { calculatePearsonCorrelation, getPrimaryTrackClips } from '@/utils/referenceComparison';

const logger = createLogger('AnalysisTools');

function resolveAnalysisOptions(args: Record<string, unknown>): AnalysisOptions {
  const nestedOptions =
    args.options && typeof args.options === 'object' && !Array.isArray(args.options)
      ? (args.options as Record<string, unknown>)
      : {};

  const readFlag = (key: keyof AnalysisOptions, fallback: boolean): boolean => {
    const value = nestedOptions[key] ?? args[key];
    return typeof value === 'boolean' ? value : fallback;
  };

  return {
    shots: readFlag('shots', true),
    transcript: readFlag('transcript', true),
    audio: readFlag('audio', true),
    segments: readFlag('segments', true),
    visual: readFlag('visual', true),
    localOnly: readFlag('localOnly', false),
  };
}

// =============================================================================
// Tool Definitions
// =============================================================================

const ANALYSIS_TOOLS: ToolDefinition[] = [
  // ---------------------------------------------------------------------------
  // Get Asset Catalog
  // ---------------------------------------------------------------------------
  {
    name: 'get_asset_catalog',
    description:
      'Get imported project assets with timeline usage status to discover source media not yet used on the timeline',
    category: 'analysis',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
    handler: async () => {
      try {
        const result = getAssetCatalogSnapshot();
        logger.debug('get_asset_catalog executed', {
          totalAssetCount: result.totalAssetCount,
          unusedAssetCount: result.unusedAssetCount,
        });
        return { success: true, result };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('get_asset_catalog failed', { error: message });
        return { success: false, error: message };
      }
    },
  },

  // ---------------------------------------------------------------------------
  // Get Unused Assets
  // ---------------------------------------------------------------------------
  {
    name: 'get_unused_assets',
    description:
      'List imported assets that are currently unused on the active timeline, optionally filtered by media kind',
    category: 'analysis',
    parameters: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          description: 'Optional asset kind filter: video, audio, or image',
        },
      },
      required: [],
    },
    handler: async (args) => {
      try {
        const result = getUnusedAssets(args.kind as 'video' | 'audio' | 'image' | undefined);

        logger.debug('get_unused_assets executed', {
          kind: args.kind,
          count: result.length,
        });
        return { success: true, result };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('get_unused_assets failed', { error: message });
        return { success: false, error: message };
      }
    },
  },

  // ---------------------------------------------------------------------------
  // Get Asset Info
  // ---------------------------------------------------------------------------
  {
    name: 'get_asset_info',
    description:
      'Get detailed information about a single imported asset and whether it is currently used on timeline',
    category: 'analysis',
    parameters: {
      type: 'object',
      properties: {
        assetId: {
          type: 'string',
          description: 'The ID of the asset',
        },
      },
      required: ['assetId'],
    },
    handler: async (args) => {
      try {
        const result = getAssetSnapshotById(args.assetId as string);

        if (!result) {
          return { success: false, error: `Asset '${args.assetId}' not found` };
        }

        logger.debug('get_asset_info executed', { assetId: args.assetId });
        return { success: true, result };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('get_asset_info failed', { error: message });
        return { success: false, error: message };
      }
    },
  },

  // ---------------------------------------------------------------------------
  // Get Timeline Info
  // ---------------------------------------------------------------------------
  {
    name: 'get_timeline_info',
    description:
      'Get general information about the current timeline/sequence including duration, track count, clip count, and playhead position',
    category: 'analysis',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
    handler: async () => {
      try {
        const snapshot = getTimelineSnapshot();

        const result = {
          stateVersion: snapshot.stateVersion,
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
        const snapshot = getTimelineSnapshot();

        logger.debug('get_playhead_position executed', {
          position: snapshot.playheadPosition,
        });
        return {
          success: true,
          result: {
            position: snapshot.playheadPosition,
            duration: snapshot.duration,
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

  // ---------------------------------------------------------------------------
  // Get Workspace Files
  // ---------------------------------------------------------------------------
  {
    name: 'get_workspace_files',
    description:
      'List all media files in the project workspace folder. Returns files with their registration status (whether they are already imported as project assets). Use this to discover available media.',
    category: 'analysis',
    parameters: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          description: 'Optional filter: video, audio, or image',
        },
      },
      required: [],
    },
    handler: async (args: Record<string, unknown>) => {
      try {
        const kind = args.kind as string | undefined;
        const validKinds = ['video', 'audio', 'image'];
        const filterKind =
          kind && validKinds.includes(kind) ? (kind as 'video' | 'audio' | 'image') : undefined;

        const files = getWorkspaceFiles(filterKind);
        logger.debug('get_workspace_files executed', { count: files.length });
        return { success: true, result: { files, count: files.length } };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('get_workspace_files failed', { error: message });
        return { success: false, error: message };
      }
    },
  },

  // ---------------------------------------------------------------------------
  // Find Workspace File
  // ---------------------------------------------------------------------------
  {
    name: 'find_workspace_file',
    description:
      'Find a specific file in the workspace by name or path pattern (case-insensitive substring match). Searches both file names and relative paths.',
    category: 'analysis',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query (file name or path substring)',
        },
      },
      required: ['query'],
    },
    handler: async (args: Record<string, unknown>) => {
      try {
        const query = args.query as string;
        if (!query || typeof query !== 'string') {
          return { success: false, error: 'query parameter is required' };
        }

        const files = findWorkspaceFile(query);
        logger.debug('find_workspace_file executed', {
          query,
          resultCount: files.length,
        });
        return { success: true, result: { files, count: files.length } };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('find_workspace_file failed', { error: message });
        return { success: false, error: message };
      }
    },
  },

  // ---------------------------------------------------------------------------
  // Get Unregistered Files
  // ---------------------------------------------------------------------------
  {
    name: 'get_unregistered_files',
    description:
      'List workspace files that are NOT yet registered as project assets. These files exist in the project folder but have not been imported. Useful to discover new media to add to the timeline.',
    category: 'analysis',
    parameters: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          description: 'Optional filter: video, audio, or image',
        },
      },
      required: [],
    },
    handler: async (args: Record<string, unknown>) => {
      try {
        const kind = args.kind as string | undefined;
        const validKinds = ['video', 'audio', 'image'];
        const filterKind =
          kind && validKinds.includes(kind) ? (kind as 'video' | 'audio' | 'image') : undefined;

        const files = getUnregisteredWorkspaceFiles(filterKind);
        logger.debug('get_unregistered_files executed', { count: files.length });
        return { success: true, result: { files, count: files.length } };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('get_unregistered_files failed', { error: message });
        return { success: false, error: message };
      }
    },
  },

  // ---------------------------------------------------------------------------
  // Analyze Reference Video
  // ---------------------------------------------------------------------------
  {
    name: 'analyze_reference_video',
    description:
      'Run full analysis on a reference video (shots, audio, segments, visual) and return a summary bundle',
    category: 'analysis',
    parameters: {
      type: 'object',
      properties: {
        assetId: { type: 'string', description: 'Asset ID of the reference video to analyze' },
        options: {
          type: 'object',
          description: 'Optional analysis flags passed to the backend pipeline',
        },
        shots: { type: 'boolean', description: 'Include shot detection (default: true)' },
        transcript: { type: 'boolean', description: 'Include transcript (default: true)' },
        audio: { type: 'boolean', description: 'Include audio profiling (default: true)' },
        segments: { type: 'boolean', description: 'Include content segmentation (default: true)' },
        visual: { type: 'boolean', description: 'Include visual frame analysis (default: true)' },
        localOnly: {
          type: 'boolean',
          description: 'Skip Vision API work and use local analysis where supported',
        },
      },
      required: ['assetId'],
    },
    handler: async (args) => {
      try {
        const assetId = args.assetId as string;
        if (!assetId) {
          return { success: false, error: 'assetId is required' };
        }
        const options = resolveAnalysisOptions(args as Record<string, unknown>);
        const bundle = await invoke<AnalysisBundle>('analyze_video_full', { assetId, options });
        const shotCount = bundle.shots?.length ?? 0;
        const segmentCount = bundle.segments?.length ?? 0;
        const hasAudio = bundle.audioProfile !== null;
        const hasTranscript = bundle.transcript !== null;
        const errorCount = Object.keys(bundle.errors ?? {}).length;
        logger.debug('analyze_reference_video completed', { assetId, shotCount });
        return {
          success: true,
          result: {
            assetId,
            shotCount,
            segmentCount,
            hasAudioProfile: hasAudio,
            hasTranscript,
            errorCount,
            analyzedAt: bundle.analyzedAt,
            summary: `Analyzed ${shotCount} shots, ${segmentCount} segments. Audio: ${hasAudio ? 'yes' : 'no'}, Transcript: ${hasTranscript ? 'yes' : 'no'}.${errorCount > 0 ? ` Partial failures: ${errorCount}.` : ''}`,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('analyze_reference_video failed', { error: message });
        return { success: false, error: message };
      }
    },
  },

  // ---------------------------------------------------------------------------
  // Generate Style Document
  // ---------------------------------------------------------------------------
  {
    name: 'generate_style_document',
    description:
      'Generate an Editing Style Document (ESD) from a previously analyzed reference video',
    category: 'analysis',
    parameters: {
      type: 'object',
      properties: {
        assetId: { type: 'string', description: 'Asset ID of the analyzed reference video' },
        name: { type: 'string', description: 'Optional display name for the ESD' },
      },
      required: ['assetId'],
    },
    handler: async (args) => {
      try {
        const assetId = args.assetId as string;
        if (!assetId) {
          return { success: false, error: 'assetId is required' };
        }
        const requestedName =
          typeof args.name === 'string' && args.name.trim() ? args.name.trim() : undefined;
        const cachedBundle = await invoke<AnalysisBundle | null>('get_analysis_bundle', {
          assetId,
        });
        const bundle =
          cachedBundle ??
          (await invoke<AnalysisBundle>('analyze_video_full', {
            assetId,
            options: resolveAnalysisOptions({}),
          }));
        const esd = await invoke<EditingStyleDocument>('generate_esd', { bundle });
        logger.debug('generate_style_document completed', { assetId, esdId: esd.id });
        return {
          success: true,
          result: {
            esdId: esd.id,
            name: esd.name,
            assetId: esd.sourceAssetId,
            analysisSource: cachedBundle ? 'cached' : 'generated',
            requestedName,
            tempoClassification: esd.rhythmProfile.tempoClassification,
            shotCount: esd.rhythmProfile.shotDurations.length,
            pacingPointCount: esd.pacingCurve.length,
            summary: `Created ESD "${esd.name}" — ${esd.rhythmProfile.tempoClassification} tempo, ${esd.rhythmProfile.shotDurations.length} shots.${requestedName && requestedName !== esd.name ? ` Requested name "${requestedName}" is not yet persisted by the backend.` : ''}`,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('generate_style_document failed', { error: message });
        return { success: false, error: message };
      }
    },
  },

  // ---------------------------------------------------------------------------
  // Compare Edit Structure
  // ---------------------------------------------------------------------------
  {
    name: 'compare_edit_structure',
    description:
      'Compare an ESD pacing curve with the current timeline to show structural similarity and differences',
    category: 'analysis',
    parameters: {
      type: 'object',
      properties: {
        esdId: {
          type: 'string',
          description: 'ID of the Editing Style Document to compare against',
        },
      },
      required: ['esdId'],
    },
    handler: async (args) => {
      try {
        const esdId = args.esdId as string;
        if (!esdId) {
          return { success: false, error: 'esdId is required' };
        }
        const esd = await invoke<EditingStyleDocument | null>('get_esd', { esdId });
        if (!esd) {
          return { success: false, error: `ESD not found: ${esdId}` };
        }
        const snapshot = getTimelineSnapshot();
        if (!snapshot.sequenceId) {
          return { success: false, error: 'No active timeline found' };
        }

        const primaryTrackClips = getPrimaryTrackClips(
          snapshot.tracks.map((track) => ({
            id: track.id,
            kind: track.kind,
            visible: track.visible,
          })),
          snapshot.clips.map((clip) => ({
            trackId: clip.trackId,
            timelineInSec: clip.timelineIn,
            durationSec: clip.duration,
          })),
        );
        const outputDurations = primaryTrackClips.map((clip) => clip.durationSec);
        const refDurations = esd.rhythmProfile.shotDurations;
        const correlation = calculatePearsonCorrelation(refDurations, outputDurations);

        logger.debug('compare_edit_structure completed', { esdId, correlation });
        return {
          success: true,
          result: {
            esdId,
            esdName: esd.name,
            referenceShots: refDurations.length,
            outputShots: outputDurations.length,
            primaryTrackId: primaryTrackClips[0]?.trackId ?? null,
            correlation: Math.round(correlation * 1000) / 1000,
            correlationPercent: `${Math.round(correlation * 100)}%`,
            shotCountDiff: outputDurations.length - refDurations.length,
            summary: `Pacing correlation: ${Math.round(correlation * 100)}% — Reference: ${refDurations.length} shots, Output: ${outputDurations.length} shots on the primary video track.`,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('compare_edit_structure failed', { error: message });
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
