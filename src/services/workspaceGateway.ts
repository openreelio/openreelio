/**
 * Workspace Gateway
 *
 * Centralizes workspace IPC calls with runtime payload validation,
 * latency monitoring, and input sanitization.
 */

import { invoke } from '@tauri-apps/api/core';
import type { FileTreeEntry, RegisterFileResult, WorkspaceScanResult } from '@/types';
import { createLogger } from '@/services/logger';
import {
  parseRegisterFileResult,
  parseRegisterFileResults,
  parseRelativeWorkspacePath,
  parseRelativeWorkspacePathList,
  parseWorkspaceScanResult,
  parseWorkspaceTree,
} from '@/schemas/workspaceSchemas';

const logger = createLogger('WorkspaceGateway');

const SLOW_IPC_WARNING_THRESHOLD_MS = 750;

type WorkspaceCommand =
  | 'scan_workspace'
  | 'get_workspace_tree'
  | 'register_workspace_file'
  | 'register_workspace_files';

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function invokeAndValidate<T>(
  command: WorkspaceCommand,
  parser: (input: unknown) => T,
  args?: Record<string, unknown>,
): Promise<T> {
  const startedAt = performance.now();

  try {
    const response = await invoke<unknown>(command, args);
    const parsed = parser(response);
    const durationMs = Math.round(performance.now() - startedAt);

    if (durationMs >= SLOW_IPC_WARNING_THRESHOLD_MS) {
      logger.warn('Slow workspace IPC call detected', { command, durationMs });
    } else {
      logger.debug('Workspace IPC call succeeded', { command, durationMs });
    }

    return parsed;
  } catch (error) {
    const message = toErrorMessage(error);
    logger.error('Workspace IPC call failed', {
      command,
      durationMs: Math.round(performance.now() - startedAt),
      error: message,
    });
    throw error instanceof Error ? error : new Error(message);
  }
}

export async function scanWorkspaceFromBackend(): Promise<WorkspaceScanResult> {
  return invokeAndValidate('scan_workspace', parseWorkspaceScanResult);
}

export async function fetchWorkspaceTreeFromBackend(): Promise<FileTreeEntry[]> {
  return invokeAndValidate('get_workspace_tree', parseWorkspaceTree);
}

export async function registerWorkspaceFileInBackend(
  relativePath: string,
): Promise<RegisterFileResult> {
  const normalizedPath = parseRelativeWorkspacePath(relativePath);

  return invokeAndValidate('register_workspace_file', parseRegisterFileResult, {
    relativePath: normalizedPath,
  });
}

export async function registerWorkspaceFilesInBackend(
  relativePaths: string[],
): Promise<RegisterFileResult[]> {
  const normalizedPaths = parseRelativeWorkspacePathList(relativePaths);

  if (normalizedPaths.length === 0) {
    return [];
  }

  return invokeAndValidate('register_workspace_files', parseRegisterFileResults, {
    relativePaths: normalizedPaths,
  });
}

export { parseRelativeWorkspacePath, parseRelativeWorkspacePathList };
