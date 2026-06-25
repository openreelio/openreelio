/**
 * Analysis Tools - Asset Queries
 *
 * Read-only tools that query imported assets and their timeline usage.
 */

import { type ToolDefinition } from '../../ToolRegistry';
import { createLogger } from '@/services/logger';
import {
  getAssetCatalogSnapshot,
  getAssetSnapshotById,
  getUnusedAssets,
  findClipsByAsset,
} from '../storeAccessor';

const logger = createLogger('AnalysisTools');

export const ASSET_TOOLS: ToolDefinition[] = [
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
];
