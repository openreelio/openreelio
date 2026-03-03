/**
 * Workspace Tools
 *
 * Agent tools for folder-level editing workflows (docs, AGENTS.md, prompts).
 */

import { globalToolRegistry, type ToolDefinition } from '../ToolRegistry';
import { createLogger } from '@/services/logger';
import {
  listWorkspaceDocumentsFromBackend,
  readWorkspaceDocumentFromBackend,
  writeWorkspaceDocumentToBackend,
} from '@/services/workspaceGateway';
import { executeAgentCommand } from './commandExecutor';

const logger = createLogger('WorkspaceTools');

function countOccurrences(source: string, needle: string): number {
  if (!needle) {
    return 0;
  }

  let count = 0;
  let index = source.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = source.indexOf(needle, index + needle.length);
  }

  return count;
}

const WORKSPACE_TOOLS: ToolDefinition[] = [
  {
    name: 'list_workspace_documents',
    description:
      'List editable text documents in the project folder (including markdown docs like AGENTS.md)',
    category: 'utility',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Optional substring filter for file path/name',
        },
        limit: {
          type: 'integer',
          description: 'Maximum number of files to return (default: 500)',
        },
      },
      required: [],
    },
    handler: async (args) => {
      try {
        const query = typeof args.query === 'string' ? args.query : undefined;
        const rawLimit = args.limit;
        const limit =
          typeof rawLimit === 'number' && Number.isFinite(rawLimit)
            ? Math.trunc(rawLimit)
            : undefined;

        const files = await listWorkspaceDocumentsFromBackend(query, limit);
        return {
          success: true,
          result: {
            files,
            count: files.length,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('list_workspace_documents failed', { error: message });
        return { success: false, error: message };
      }
    },
  },
  {
    name: 'read_workspace_document',
    description: 'Read UTF-8 text content from a workspace document by relative path',
    category: 'utility',
    parameters: {
      type: 'object',
      properties: {
        relativePath: {
          type: 'string',
          description: 'Path relative to project root (example: docs/ROADMAP.md)',
        },
      },
      required: ['relativePath'],
    },
    handler: async (args) => {
      try {
        const relativePath = args.relativePath as string;
        const document = await readWorkspaceDocumentFromBackend(relativePath);
        return { success: true, result: document };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('read_workspace_document failed', { error: message });
        return { success: false, error: message };
      }
    },
  },
  {
    name: 'write_workspace_document',
    description:
      'Write UTF-8 text content to a workspace document. Can update AGENTS.md/docs and create missing files.',
    category: 'utility',
    parameters: {
      type: 'object',
      properties: {
        relativePath: {
          type: 'string',
          description: 'Path relative to project root',
        },
        content: {
          type: 'string',
          description: 'Full UTF-8 document content to write',
        },
        createIfMissing: {
          type: 'boolean',
          description: 'Create the file when it does not exist (default: true)',
        },
      },
      required: ['relativePath', 'content'],
    },
    handler: async (args) => {
      try {
        const relativePath = args.relativePath as string;
        const content = args.content as string;
        const createIfMissing =
          typeof args.createIfMissing === 'boolean' ? args.createIfMissing : true;

        const result = await writeWorkspaceDocumentToBackend(
          relativePath,
          content,
          createIfMissing,
        );
        return { success: true, result };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('write_workspace_document failed', { error: message });
        return { success: false, error: message };
      }
    },
  },
  {
    name: 'replace_workspace_document_text',
    description:
      'Replace text in a workspace document by exact substring match, then write changes back',
    category: 'utility',
    parameters: {
      type: 'object',
      properties: {
        relativePath: {
          type: 'string',
          description: 'Path relative to project root',
        },
        searchText: {
          type: 'string',
          description: 'Exact text to search for',
        },
        replaceText: {
          type: 'string',
          description: 'Replacement text',
        },
        replaceAll: {
          type: 'boolean',
          description: 'Replace every occurrence (default: true)',
        },
      },
      required: ['relativePath', 'searchText', 'replaceText'],
    },
    handler: async (args) => {
      try {
        const relativePath = args.relativePath as string;
        const searchText = args.searchText as string;
        const replaceText = args.replaceText as string;
        const replaceAll = typeof args.replaceAll === 'boolean' ? args.replaceAll : true;

        if (searchText.length === 0) {
          return { success: false, error: 'searchText must not be empty' };
        }

        const document = await readWorkspaceDocumentFromBackend(relativePath);
        const occurrences = countOccurrences(document.content, searchText);

        if (occurrences === 0) {
          return {
            success: true,
            result: {
              relativePath,
              changed: false,
              replacements: 0,
            },
          };
        }

        const nextContent = replaceAll
          ? document.content.split(searchText).join(replaceText)
          : document.content.replace(searchText, replaceText);
        const replacements = replaceAll ? occurrences : 1;

        await writeWorkspaceDocumentToBackend(relativePath, nextContent, false);

        return {
          success: true,
          result: {
            relativePath,
            changed: true,
            replacements,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('replace_workspace_document_text failed', { error: message });
        return { success: false, error: message };
      }
    },
  },
  {
    name: 'create_workspace_folder',
    description: 'Create a folder inside the project workspace',
    category: 'utility',
    parameters: {
      type: 'object',
      properties: {
        relativePath: {
          type: 'string',
          description: 'Folder path relative to project root',
        },
      },
      required: ['relativePath'],
    },
    handler: async (args) => {
      try {
        const result = await executeAgentCommand('CreateFolder', {
          relativePath: args.relativePath as string,
        });
        return { success: true, result };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('create_workspace_folder failed', { error: message });
        return { success: false, error: message };
      }
    },
  },
  {
    name: 'rename_workspace_entry',
    description: 'Rename a file or folder in the workspace',
    category: 'utility',
    parameters: {
      type: 'object',
      properties: {
        oldRelativePath: {
          type: 'string',
          description: 'Current path relative to project root',
        },
        newName: {
          type: 'string',
          description: 'New file/folder name only',
        },
      },
      required: ['oldRelativePath', 'newName'],
    },
    handler: async (args) => {
      try {
        const result = await executeAgentCommand('RenameFile', {
          oldRelativePath: args.oldRelativePath as string,
          newName: args.newName as string,
        });
        return { success: true, result };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('rename_workspace_entry failed', { error: message });
        return { success: false, error: message };
      }
    },
  },
  {
    name: 'move_workspace_entry',
    description: 'Move a file or folder to another workspace folder',
    category: 'utility',
    parameters: {
      type: 'object',
      properties: {
        sourcePath: {
          type: 'string',
          description: 'Source file/folder relative path',
        },
        destFolderPath: {
          type: 'string',
          description: 'Target folder relative path',
        },
      },
      required: ['sourcePath', 'destFolderPath'],
    },
    handler: async (args) => {
      try {
        const result = await executeAgentCommand('MoveFile', {
          sourcePath: args.sourcePath as string,
          destFolderPath: args.destFolderPath as string,
        });
        return { success: true, result };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('move_workspace_entry failed', { error: message });
        return { success: false, error: message };
      }
    },
  },
  {
    name: 'delete_workspace_entry',
    description: 'Delete a file or folder from workspace (moved to trash by backend)',
    category: 'utility',
    parameters: {
      type: 'object',
      properties: {
        relativePath: {
          type: 'string',
          description: 'Path relative to project root',
        },
      },
      required: ['relativePath'],
    },
    handler: async (args) => {
      try {
        const result = await executeAgentCommand('DeleteFile', {
          relativePath: args.relativePath as string,
        });
        return { success: true, result };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('delete_workspace_entry failed', { error: message });
        return { success: false, error: message };
      }
    },
  },
];

export function registerWorkspaceTools(): void {
  globalToolRegistry.registerMany(WORKSPACE_TOOLS);
  logger.info('Workspace tools registered', { count: WORKSPACE_TOOLS.length });
}

export function unregisterWorkspaceTools(): void {
  for (const tool of WORKSPACE_TOOLS) {
    globalToolRegistry.unregister(tool.name);
  }
  logger.info('Workspace tools unregistered', { count: WORKSPACE_TOOLS.length });
}

/** Pre-computed workspace tool names (static after module load). */
const WORKSPACE_TOOL_NAMES: readonly string[] = WORKSPACE_TOOLS.map((tool) => tool.name);

export function getWorkspaceToolNames(): readonly string[] {
  return WORKSPACE_TOOL_NAMES;
}
