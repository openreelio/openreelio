/**
 * Asset Discovery Tools
 *
 * Agent-facing tools for finding external media candidates. These tools only
 * return provider references and license policy decisions; they do not import
 * or place external assets on the timeline.
 */

import { invoke } from '@tauri-apps/api/core';
import { globalToolRegistry, type ToolDefinition } from '../ToolRegistry';
import { createLogger } from '@/services/logger';

const logger = createLogger('AssetDiscoveryTools');

type AssetDiscoveryResult = {
  id: string;
  name: string;
  assetType: string;
  thumbnail: string | null;
  durationSec: number | null;
  sizeBytes: number | null;
  tags: string[];
  provider: string;
  license: Record<string, unknown>;
  licensePolicy: {
    status: 'allowed' | 'warning' | 'blocked';
    requiredActions: string[];
    reasons: string[];
  };
  metadata: Record<string, unknown>;
};

type StockAssetType = 'video' | 'image' | 'audio';

function normalizeAssetType(value: unknown): StockAssetType {
  return value === 'image' || value === 'audio' || value === 'video' ? value : 'video';
}

function normalizeLimit(value: unknown): number {
  return Math.min(Math.max(typeof value === 'number' ? value : 10, 1), 50);
}

async function searchStockMedia(args: {
  query: string;
  type?: StockAssetType;
  count?: number;
}): Promise<{
  count: number;
  query: string;
  requiresImport: true;
  assets: AssetDiscoveryResult[];
  policySummary: Record<string, number>;
}> {
  const query = args.query.trim();
  if (!query) {
    throw new Error('Query cannot be empty');
  }

  const assetType = normalizeAssetType(args.type);
  const limit = normalizeLimit(args.count);

  const assets = await invoke<AssetDiscoveryResult[]>('search_stock_media', {
    query,
    assetType,
    limit,
  });

  const policySummary = assets.reduce<Record<string, number>>((acc, asset) => {
    const status = asset.licensePolicy?.status ?? 'unknown';
    acc[status] = (acc[status] ?? 0) + 1;
    return acc;
  }, {});

  return {
    count: assets.length,
    query,
    requiresImport: true,
    assets,
    policySummary,
  };
}

const ASSET_DISCOVERY_TOOLS: ToolDefinition[] = [
  {
    name: 'search_stock_media',
    description:
      'Search configured stock media providers for video, image, or audio candidates. Returns provider references, previews, normalized license info, and license policy decisions. Does not import assets.',
    category: 'analysis',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Concise visual or audio search query.',
        },
        type: {
          type: 'string',
          enum: ['video', 'image', 'audio'],
          description: 'Asset type to search for. Defaults to video.',
        },
        count: {
          type: 'number',
          description: 'Maximum number of results, from 1 to 50. Defaults to 10.',
        },
      },
      required: ['query'],
    },
    handler: async (args) => {
      try {
        const result = await searchStockMedia({
          query: String(args.query ?? ''),
          type: normalizeAssetType(args.type),
          count: normalizeLimit(args.count),
        });
        return { success: true, result };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('search_stock_media failed', { error: message });
        return { success: false, error: message };
      }
    },
  },
  {
    name: 'find_assets_for_script',
    description:
      'Find provider-backed media candidates for a script or scene segment. Use this as the high-level asset discovery entry point before import or timeline placement.',
    category: 'analysis',
    parameters: {
      type: 'object',
      properties: {
        scriptText: {
          type: 'string',
          description: 'Script, narration, or scene description to search against.',
        },
        assetType: {
          type: 'string',
          enum: ['video', 'image', 'audio'],
          description: 'Desired asset type. Defaults to video.',
        },
        count: {
          type: 'number',
          description: 'Maximum number of results, from 1 to 50. Defaults to 10.',
        },
      },
      required: ['scriptText'],
    },
    handler: async (args) => {
      try {
        const scriptText = String(args.scriptText ?? '').trim();
        if (!scriptText) {
          return { success: false, error: 'scriptText cannot be empty' };
        }

        const result = await searchStockMedia({
          query: scriptText,
          type: normalizeAssetType(args.assetType),
          count: normalizeLimit(args.count),
        });
        return { success: true, result };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('find_assets_for_script failed', { error: message });
        return { success: false, error: message };
      }
    },
  },
];

export function registerAssetDiscoveryTools(): void {
  globalToolRegistry.registerMany(ASSET_DISCOVERY_TOOLS);
  logger.info('Asset discovery tools registered', { count: ASSET_DISCOVERY_TOOLS.length });
}

export function unregisterAssetDiscoveryTools(): void {
  for (const tool of ASSET_DISCOVERY_TOOLS) {
    globalToolRegistry.unregister(tool.name);
  }
  logger.info('Asset discovery tools unregistered', { count: ASSET_DISCOVERY_TOOLS.length });
}

export function getAssetDiscoveryToolNames(): string[] {
  return ASSET_DISCOVERY_TOOLS.map((tool) => tool.name);
}
