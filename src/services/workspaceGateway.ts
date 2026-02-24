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
import { parseWorkspaceScanResult, parseWorkspaceTree } from '@/schemas/workspaceSchemas';

const logger = createLogger('WorkspaceGateway');

const SLOW_IPC_WARNING_THRESHOLD_MS = 750;

type WorkspaceQueryCommand =
  | 'scan_workspace'
  | 'get_workspace_tree'
  | 'reveal_in_explorer'
  | 'list_workspace_documents'
  | 'read_workspace_document'
  | 'write_workspace_document';

export interface WorkspaceDocumentEntry {
  relativePath: string;
  sizeBytes: number;
  modifiedAtUnixSec: number;
}

export interface WorkspaceDocument {
  relativePath: string;
  content: string;
  sizeBytes: number;
  modifiedAtUnixSec: number;
}

export interface WorkspaceDocumentWriteResult {
  relativePath: string;
  bytesWritten: number;
  created: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseWorkspaceDocumentEntry(input: unknown): WorkspaceDocumentEntry {
  if (!isRecord(input)) {
    throw new Error('Invalid workspace document entry payload');
  }

  const relativePath = input.relativePath;
  const sizeBytes = input.sizeBytes;
  const modifiedAtUnixSec = input.modifiedAtUnixSec;

  if (
    typeof relativePath !== 'string' ||
    typeof sizeBytes !== 'number' ||
    !Number.isFinite(sizeBytes) ||
    typeof modifiedAtUnixSec !== 'number' ||
    !Number.isFinite(modifiedAtUnixSec)
  ) {
    throw new Error('Invalid workspace document entry fields');
  }

  return {
    relativePath,
    sizeBytes,
    modifiedAtUnixSec,
  };
}

function parseWorkspaceDocumentList(input: unknown): WorkspaceDocumentEntry[] {
  if (!Array.isArray(input)) {
    throw new Error('Invalid workspace document list payload');
  }

  return input.map(parseWorkspaceDocumentEntry);
}

function parseWorkspaceDocument(input: unknown): WorkspaceDocument {
  if (!isRecord(input)) {
    throw new Error('Invalid workspace document payload');
  }

  const relativePath = input.relativePath;
  const content = input.content;
  const sizeBytes = input.sizeBytes;
  const modifiedAtUnixSec = input.modifiedAtUnixSec;

  if (
    typeof relativePath !== 'string' ||
    typeof content !== 'string' ||
    typeof sizeBytes !== 'number' ||
    !Number.isFinite(sizeBytes) ||
    typeof modifiedAtUnixSec !== 'number' ||
    !Number.isFinite(modifiedAtUnixSec)
  ) {
    throw new Error('Invalid workspace document fields');
  }

  return {
    relativePath,
    content,
    sizeBytes,
    modifiedAtUnixSec,
  };
}

function parseWorkspaceDocumentWriteResult(input: unknown): WorkspaceDocumentWriteResult {
  if (!isRecord(input)) {
    throw new Error('Invalid workspace document write payload');
  }

  const relativePath = input.relativePath;
  const bytesWritten = input.bytesWritten;
  const created = input.created;

  if (
    typeof relativePath !== 'string' ||
    typeof bytesWritten !== 'number' ||
    !Number.isFinite(bytesWritten) ||
    typeof created !== 'boolean'
  ) {
    throw new Error('Invalid workspace document write fields');
  }

  return {
    relativePath,
    bytesWritten,
    created,
  };
}

/**
 * Validate that a relative path does not escape the project root.
 * Defense-in-depth: the Rust backend MUST also validate, but we reject
 * obvious traversal attempts early to avoid unnecessary IPC round-trips.
 */
export function validateRelativePath(relativePath: string): void {
  if (typeof relativePath !== 'string' || relativePath.length === 0) {
    throw new Error('Relative path must be a non-empty string');
  }

  // Reject null bytes (can truncate paths in C-based systems)
  if (relativePath.includes('\0')) {
    throw new Error('Path must not contain null bytes');
  }

  // Normalize backslashes to forward slashes for consistent checking
  const normalized = relativePath.replace(/\\/g, '/');

  // Reject absolute paths
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
    throw new Error('Path must be relative, not absolute');
  }

  // Reject directory traversal
  const segments = normalized.split('/');
  for (const segment of segments) {
    if (segment === '..') {
      throw new Error('Path must not contain directory traversal (..)');
    }
  }
}

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
  validateRelativePath(relativePath);
  return executeFilesystemCommand('CreateFolder', { relativePath });
}

export async function renameFileInBackend(oldRelativePath: string, newName: string): Promise<void> {
  validateRelativePath(oldRelativePath);
  if (newName.includes('/') || newName.includes('\\') || newName.includes('\0')) {
    throw new Error('New name must not contain path separators or null bytes');
  }
  return executeFilesystemCommand('RenameFile', { oldRelativePath, newName });
}

export async function moveFileInBackend(sourcePath: string, destFolderPath: string): Promise<void> {
  validateRelativePath(sourcePath);
  validateRelativePath(destFolderPath);
  return executeFilesystemCommand('MoveFile', { sourcePath, destFolderPath });
}

export async function deleteFileInBackend(relativePath: string): Promise<void> {
  validateRelativePath(relativePath);
  return executeFilesystemCommand('DeleteFile', { relativePath });
}

export async function revealInExplorerFromBackend(relativePath: string): Promise<void> {
  validateRelativePath(relativePath);
  return invokeAndValidate('reveal_in_explorer', (r) => r as void, { relativePath });
}

export async function listWorkspaceDocumentsFromBackend(
  query?: string,
  limit?: number,
): Promise<WorkspaceDocumentEntry[]> {
  return invokeAndValidate('list_workspace_documents', parseWorkspaceDocumentList, {
    query,
    limit,
  });
}

export async function readWorkspaceDocumentFromBackend(
  relativePath: string,
): Promise<WorkspaceDocument> {
  validateRelativePath(relativePath);
  return invokeAndValidate('read_workspace_document', parseWorkspaceDocument, {
    relativePath,
  });
}

export async function writeWorkspaceDocumentToBackend(
  relativePath: string,
  content: string,
  createIfMissing = true,
): Promise<WorkspaceDocumentWriteResult> {
  validateRelativePath(relativePath);
  return invokeAndValidate('write_workspace_document', parseWorkspaceDocumentWriteResult, {
    relativePath,
    content,
    createIfMissing,
  });
}
