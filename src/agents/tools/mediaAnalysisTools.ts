/**
 * Media Analysis Tools
 *
 * Agent tools that bridge workspace/media assets to backend analysis commands.
 */

import { commands, type AnalysisProvider, type AnalysisType } from '@/bindings';
import { globalToolRegistry, type ToolDefinition } from '../ToolRegistry';
import { createLogger } from '@/services/logger';
import { useAnnotationStore } from '@/stores/annotationStore';
import { findWorkspaceFile } from './storeAccessor';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { refreshProjectState } from '@/utils/stateRefreshHelper';
import { useProjectStore } from '@/stores/projectStore';

const logger = createLogger('MediaAnalysisTools');

const ANALYSIS_TYPE_SET: ReadonlySet<AnalysisType> = new Set<AnalysisType>([
  'shots',
  'transcript',
  'objects',
  'faces',
  'textOcr',
]);

function parseAnalysisTypes(value: unknown): AnalysisType[] {
  if (!Array.isArray(value)) {
    return ['shots'];
  }

  const parsed = value
    .filter((item): item is string => typeof item === 'string')
    .filter((item): item is AnalysisType => ANALYSIS_TYPE_SET.has(item as AnalysisType));

  return parsed.length > 0 ? parsed : ['shots'];
}

function parseProvider(value: unknown): AnalysisProvider {
  if (value && typeof value === 'object' && 'custom' in value) {
    const custom = (value as { custom?: unknown }).custom;
    if (typeof custom === 'string' && custom.trim().length > 0) {
      return { custom };
    }
  }

  if (typeof value === 'string') {
    if (value === 'ffmpeg' || value === 'whisper' || value === 'google_cloud') {
      return value;
    }

    return { custom: value };
  }

  return useAnnotationStore.getState().selectedProvider;
}

function findAssetIdInTree(
  entries: ReturnType<typeof useWorkspaceStore.getState>['fileTree'],
  relativePath: string,
): string | undefined {
  for (const entry of entries) {
    if (!entry.isDirectory && entry.relativePath === relativePath) {
      return entry.assetId;
    }
    if (entry.isDirectory) {
      const found = findAssetIdInTree(entry.children, relativePath);
      if (found) {
        return found;
      }
    }
  }
  return undefined;
}

async function resolveWorkspaceAsset(
  file: string,
): Promise<{ assetId: string; relativePath: string }> {
  const matches = findWorkspaceFile(file);
  if (matches.length === 0) {
    throw new Error(
      `No workspace file matched '${file}'. Use list_workspace_documents or get_workspace_files first.`,
    );
  }

  const target = matches.find((entry) => entry.relativePath === file) ?? matches[0];
  let assetId = target.assetId;

  if (!assetId) {
    await useWorkspaceStore.getState().refreshTree();

    try {
      const freshState = await refreshProjectState();
      useProjectStore.setState((draft) => {
        draft.assets = freshState.assets;
      });
    } catch (error) {
      logger.warn('Failed to refresh project state while resolving workspace asset', {
        relativePath: target.relativePath,
        error,
      });
    }

    const refreshedTree = useWorkspaceStore.getState().fileTree;
    assetId = findAssetIdInTree(refreshedTree, target.relativePath);
  }

  if (!assetId) {
    throw new Error(
      `Workspace file '${target.relativePath}' is not registered as an asset. Run workspace scan first.`,
    );
  }

  return { assetId, relativePath: target.relativePath };
}

const MEDIA_ANALYSIS_TOOLS: ToolDefinition[] = [
  {
    name: 'analyze_asset',
    description:
      'Run backend media analysis (shots/transcript/objects/faces/textOcr) for an existing project asset',
    category: 'analysis',
    parameters: {
      type: 'object',
      properties: {
        assetId: {
          type: 'string',
          description: 'Target project asset ID',
        },
        provider: {
          type: 'string',
          description: 'Optional provider: ffmpeg, whisper, google_cloud, or custom name',
        },
        analysisTypes: {
          type: 'array',
          description: 'Optional list of analysis types',
        },
      },
      required: ['assetId'],
    },
    handler: async (args) => {
      try {
        const assetId = args.assetId as string;
        const provider = parseProvider(args.provider);
        const analysisTypes = parseAnalysisTypes(args.analysisTypes);

        const response = await commands.analyzeAsset({
          assetId,
          provider,
          analysisTypes,
        });

        if (response.status === 'error') {
          throw new Error(response.error);
        }

        return {
          success: true,
          result: {
            assetId,
            provider,
            analysisTypes,
            annotation: response.data.annotation,
            response: response.data.response,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('analyze_asset failed', { error: message });
        return { success: false, error: message };
      }
    },
  },
  {
    name: 'analyze_workspace_video',
    description:
      'Find a media file in the workspace by path/name, resolve asset ID, then run analysis',
    category: 'analysis',
    parameters: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          description: 'Workspace relative path or filename',
        },
        provider: {
          type: 'string',
          description: 'Optional provider: ffmpeg, whisper, google_cloud, or custom name',
        },
        analysisTypes: {
          type: 'array',
          description: 'Optional list of analysis types',
        },
      },
      required: ['file'],
    },
    handler: async (args) => {
      try {
        const file = args.file as string;
        const provider = parseProvider(args.provider);
        const analysisTypes = parseAnalysisTypes(args.analysisTypes);

        const resolved = await resolveWorkspaceAsset(file);
        const response = await commands.analyzeAsset({
          assetId: resolved.assetId,
          provider,
          analysisTypes,
        });

        if (response.status === 'error') {
          throw new Error(response.error);
        }

        return {
          success: true,
          result: {
            file: resolved.relativePath,
            assetId: resolved.assetId,
            provider,
            analysisTypes,
            annotation: response.data.annotation,
            response: response.data.response,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('analyze_workspace_video failed', { error: message });
        return { success: false, error: message };
      }
    },
  },
  {
    name: 'get_analysis_status',
    description:
      'Get current analysis status for an asset (notAnalyzed/inProgress/completed/stale/failed)',
    category: 'analysis',
    parameters: {
      type: 'object',
      properties: {
        assetId: {
          type: 'string',
          description: 'Target project asset ID',
        },
      },
      required: ['assetId'],
    },
    handler: async (args) => {
      try {
        const assetId = args.assetId as string;
        const response = await commands.getAnalysisStatus(assetId);
        if (response.status === 'error') {
          throw new Error(response.error);
        }
        return { success: true, result: { assetId, status: response.data } };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('get_analysis_status failed', { error: message });
        return { success: false, error: message };
      }
    },
  },
  {
    name: 'get_asset_annotation',
    description: 'Get stored annotation payload and status for an asset',
    category: 'analysis',
    parameters: {
      type: 'object',
      properties: {
        assetId: {
          type: 'string',
          description: 'Target project asset ID',
        },
      },
      required: ['assetId'],
    },
    handler: async (args) => {
      try {
        const assetId = args.assetId as string;
        const response = await commands.getAnnotation(assetId);
        if (response.status === 'error') {
          throw new Error(response.error);
        }
        return {
          success: true,
          result: {
            assetId,
            annotation: response.data.annotation,
            status: response.data.status,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('get_asset_annotation failed', { error: message });
        return { success: false, error: message };
      }
    },
  },
  {
    name: 'get_analysis_cost_estimate',
    description: 'Estimate analysis cost for cloud providers (returns null for local providers)',
    category: 'analysis',
    parameters: {
      type: 'object',
      properties: {
        assetId: {
          type: 'string',
          description: 'Target project asset ID',
        },
        provider: {
          type: 'string',
          description: 'Optional provider override',
        },
        analysisTypes: {
          type: 'array',
          description: 'Optional list of analysis types',
        },
      },
      required: ['assetId'],
    },
    handler: async (args) => {
      try {
        const assetId = args.assetId as string;
        const provider = parseProvider(args.provider);
        const analysisTypes = parseAnalysisTypes(args.analysisTypes);

        const response = await commands.estimateAnalysisCost(assetId, provider, analysisTypes);
        if (response.status === 'error') {
          throw new Error(response.error);
        }

        return {
          success: true,
          result: {
            assetId,
            provider,
            analysisTypes,
            estimate: response.data,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('get_analysis_cost_estimate failed', { error: message });
        return { success: false, error: message };
      }
    },
  },
  {
    name: 'get_analysis_providers',
    description: 'List available analysis providers and supported analysis types',
    category: 'analysis',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
    handler: async () => {
      try {
        const response = await commands.getAvailableProviders();
        if (response.status === 'error') {
          throw new Error(response.error);
        }

        return {
          success: true,
          result: {
            providers: response.data,
            count: response.data.length,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('get_analysis_providers failed', { error: message });
        return { success: false, error: message };
      }
    },
  },
];

export function registerMediaAnalysisTools(): void {
  globalToolRegistry.registerMany(MEDIA_ANALYSIS_TOOLS);
  logger.info('Media analysis tools registered', { count: MEDIA_ANALYSIS_TOOLS.length });
}

export function unregisterMediaAnalysisTools(): void {
  for (const tool of MEDIA_ANALYSIS_TOOLS) {
    globalToolRegistry.unregister(tool.name);
  }
  logger.info('Media analysis tools unregistered', { count: MEDIA_ANALYSIS_TOOLS.length });
}

export function getMediaAnalysisToolNames(): string[] {
  return MEDIA_ANALYSIS_TOOLS.map((tool) => tool.name);
}
