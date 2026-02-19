/**
 * Workspace Gateway
 *
 * Centralizes workspace IPC calls with runtime payload validation,
 * latency monitoring, and input sanitization.
 *
 * Direct workspace queries (scan, tree) use dedicated Tauri commands.
 * Filesystem mutations (create/rename/move/delete) go through execute_command
 * to participate in the undo/redo command system.
 */

import { invoke } from '@tauri-apps/api/core';
import type { FileTreeEntry, WorkspaceScanResult } from '@/types';
import { createLogger } from '@/services/logger';
import {
  parseWorkspaceScanResult,
  parseWorkspaceTree,
} from '@/schemas/workspaceSchemas';

const logger = createLogger('WorkspaceGateway');

const SLOW_IPC_WARNING_THRESHOLD_MS = 750;

type WorkspaceQueryCommand = 'scan_workspace' | 'get_workspace_tree' | 'reveal_in_explorer';

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function invokeAndValidate<T>(
  command: WorkspaceQueryCommand,
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

async function executeFilesystemCommand(
  commandType: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const startedAt = performance.now();

  try {
    await invoke('execute_command', { commandType, payload });
    const durationMs = Math.round(performance.now() - startedAt);

    if (durationMs >= SLOW_IPC_WARNING_THRESHOLD_MS) {
      logger.warn('Slow filesystem command detected', { commandType, durationMs });
    } else {
      logger.debug('Filesystem command succeeded', { commandType, durationMs });
    }
  } catch (error) {
    const message = toErrorMessage(error);
    logger.error('Filesystem command failed', {
      commandType,
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

export async function createFolderInBackend(relativePath: string): Promise<void> {
  return executeFilesystemCommand('CreateFolder', { relativePath });
}

export async function renameFileInBackend(
  oldRelativePath: string,
  newName: string,
): Promise<void> {
  return executeFilesystemCommand('RenameFile', { oldRelativePath, newName });
}

export async function moveFileInBackend(
  sourcePath: string,
  destFolderPath: string,
): Promise<void> {
  return executeFilesystemCommand('MoveFile', { sourcePath, destFolderPath });
}

export async function deleteFileInBackend(relativePath: string): Promise<void> {
  return executeFilesystemCommand('DeleteFile', { relativePath });
}

export async function revealInExplorerFromBackend(relativePath: string): Promise<void> {
  return invokeAndValidate('reveal_in_explorer', (r) => r as void, { relativePath });
}
