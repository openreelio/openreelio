/**
 * Analysis Tools - Workspace Queries
 *
 * Read-only tools that query workspace files and registration status.
 */

import { type ToolDefinition } from '../../ToolRegistry';
import { createLogger } from '@/services/logger';
import {
  getWorkspaceFiles,
  getUnregisteredWorkspaceFiles,
  findWorkspaceFile,
} from '../storeAccessor';

const logger = createLogger('AnalysisTools');

function parseWorkspaceKind(kind: unknown): 'video' | 'audio' | 'image' | undefined {
  if (kind === undefined || kind === null) {
    return undefined;
  }
  if (kind === 'video' || kind === 'audio' || kind === 'image') {
    return kind;
  }
  throw new Error('kind must be one of: video, audio, image');
}

export const WORKSPACE_TOOLS: ToolDefinition[] = [
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
        const filterKind = parseWorkspaceKind(args.kind);

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
        const filterKind = parseWorkspaceKind(args.kind);

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
];
