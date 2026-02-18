/**
 * Workspace Store
 *
 * Manages workspace file tree state, scanning, and file watching.
 * Provides workspace-based asset discovery and registration.
 */

import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type {
  FileTreeEntry,
  WorkspaceScanResult,
  RegisterFileResult,
  WorkspaceFileEvent,
  WorkspaceScanCompleteEvent,
} from '@/types';
import { createLogger } from '@/services/logger';

const logger = createLogger('WorkspaceStore');

// =============================================================================
// Types
// =============================================================================

interface WorkspaceState {
  /** Workspace file tree (hierarchical) */
  fileTree: FileTreeEntry[];
  /** Whether a scan is in progress */
  isScanning: boolean;
  /** Registration in-flight counters keyed by workspace relative path */
  registeringPathCounts: Record<string, number>;
  /** Whether the file watcher is active */
  isWatching: boolean;
  /** Result of the last scan */
  scanResult: WorkspaceScanResult | null;
  /** Error message from the last operation */
  error: string | null;
}

interface WorkspaceActions {
  /** Scan the project workspace for media files */
  scanWorkspace: () => Promise<void>;
  /** Refresh the file tree from the backend */
  refreshTree: () => Promise<void>;
  /** Register a single workspace file as a project asset */
  registerFile: (relativePath: string) => Promise<RegisterFileResult | null>;
  /** Register multiple workspace files as project assets */
  registerFiles: (relativePaths: string[]) => Promise<RegisterFileResult[]>;
  /** Reset the workspace store to initial state */
  reset: () => void;
}

type WorkspaceStore = WorkspaceState & WorkspaceActions;

// =============================================================================
// Initial State
// =============================================================================

const initialState: WorkspaceState = {
  fileTree: [],
  isScanning: false,
  registeringPathCounts: {},
  isWatching: false,
  scanResult: null,
  error: null,
};

function normalizeRelativePath(relativePath: string): string {
  return relativePath.trim().replace(/\\/g, '/');
}

function beginRegistration(
  registeringPathCounts: Record<string, number>,
  relativePaths: string[],
): void {
  for (const relativePath of relativePaths) {
    registeringPathCounts[relativePath] = (registeringPathCounts[relativePath] ?? 0) + 1;
  }
}

function completeRegistration(
  registeringPathCounts: Record<string, number>,
  relativePaths: string[],
): void {
  for (const relativePath of relativePaths) {
    const nextCount = (registeringPathCounts[relativePath] ?? 0) - 1;
    if (nextCount <= 0) {
      delete registeringPathCounts[relativePath];
      continue;
    }
    registeringPathCounts[relativePath] = nextCount;
  }
}

// =============================================================================
// Store
// =============================================================================

export const useWorkspaceStore = create<WorkspaceStore>()(
  immer((set, get) => ({
    ...initialState,

    scanWorkspace: async () => {
      set((state) => {
        state.isScanning = true;
        state.error = null;
      });

      try {
        const result = await invoke<WorkspaceScanResult>('scan_workspace');
        logger.info('Workspace scan complete', {
          totalFiles: result.totalFiles,
          newFiles: result.newFiles,
        });

        set((state) => {
          state.scanResult = result;
          state.isScanning = false;
        });

        // Refresh tree after scan
        await get().refreshTree();
      } catch (error) {
        const message = typeof error === 'string' ? error : String(error);
        logger.error('Workspace scan failed', { error: message });
        set((state) => {
          state.isScanning = false;
          state.error = message;
        });
      }
    },

    refreshTree: async () => {
      try {
        const tree = await invoke<FileTreeEntry[]>('get_workspace_tree');
        set((state) => {
          state.fileTree = tree;
        });
      } catch (error) {
        const message = typeof error === 'string' ? error : String(error);
        logger.error('Failed to refresh workspace tree', { error: message });
        set((state) => {
          state.error = message;
        });
      }
    },

    registerFile: async (relativePath: string) => {
      const normalizedPath = normalizeRelativePath(relativePath);
      if (normalizedPath.length === 0) {
        const message = 'relativePath is empty';
        set((state) => {
          state.error = message;
        });
        return null;
      }

      set((state) => {
        beginRegistration(state.registeringPathCounts, [normalizedPath]);
        state.error = null;
      });

      try {
        const result = await invoke<RegisterFileResult>('register_workspace_file', {
          relativePath: normalizedPath,
        });
        logger.info('Registered workspace file', {
          relativePath: result.relativePath,
          assetId: result.assetId,
        });

        // Refresh tree to update registration status
        await get().refreshTree();
        return result;
      } catch (error) {
        const message = typeof error === 'string' ? error : String(error);
        logger.error('Failed to register workspace file', { error: message });
        set((state) => {
          state.error = message;
        });
        return null;
      } finally {
        set((state) => {
          completeRegistration(state.registeringPathCounts, [normalizedPath]);
        });
      }
    },

    registerFiles: async (relativePaths: string[]) => {
      const normalizedPaths = Array.from(
        new Set(relativePaths.map(normalizeRelativePath).filter((path) => path.length > 0)),
      );

      if (normalizedPaths.length === 0) {
        return [];
      }

      set((state) => {
        beginRegistration(state.registeringPathCounts, normalizedPaths);
        state.error = null;
      });

      try {
        const results = await invoke<RegisterFileResult[]>('register_workspace_files', {
          relativePaths: normalizedPaths,
        });
        logger.info('Registered workspace files', { count: results.length });

        // Refresh tree to update registration status
        await get().refreshTree();
        return results;
      } catch (error) {
        const message = typeof error === 'string' ? error : String(error);
        logger.error('Failed to register workspace files', { error: message });
        set((state) => {
          state.error = message;
        });
        return [];
      } finally {
        set((state) => {
          completeRegistration(state.registeringPathCounts, normalizedPaths);
        });
      }
    },

    reset: () => {
      set(initialState);
    },
  })),
);

// =============================================================================
// Event Listeners
// =============================================================================

let unlistenFunctions: UnlistenFn[] = [];

/** Setup workspace event listeners from the backend watcher */
export async function setupWorkspaceEventListeners(): Promise<void> {
  // Clean up any existing listeners
  await cleanupWorkspaceEventListeners();

  const store = useWorkspaceStore.getState();

  const unlistenFileAdded = await listen<WorkspaceFileEvent>(
    'workspace:file-added',
    ({ payload }) => {
      logger.debug('File added', { relativePath: payload.relativePath });
      store.refreshTree();
    },
  );

  const unlistenFileRemoved = await listen<WorkspaceFileEvent>(
    'workspace:file-removed',
    ({ payload }) => {
      logger.debug('File removed', { relativePath: payload.relativePath });
      store.refreshTree();
    },
  );

  const unlistenFileModified = await listen<WorkspaceFileEvent>(
    'workspace:file-modified',
    ({ payload }) => {
      logger.debug('File modified', { relativePath: payload.relativePath });
      store.refreshTree();
    },
  );

  const unlistenScanComplete = await listen<WorkspaceScanCompleteEvent>(
    'workspace:scan-complete',
    ({ payload }) => {
      logger.info('Scan complete event', {
        totalFiles: payload.totalFiles,
        newFiles: payload.newFiles,
      });
      useWorkspaceStore.setState({
        scanResult: payload,
        isScanning: false,
      });
      store.refreshTree();
    },
  );

  unlistenFunctions = [
    unlistenFileAdded,
    unlistenFileRemoved,
    unlistenFileModified,
    unlistenScanComplete,
  ];

  logger.info('Workspace event listeners setup');
}

/** Cleanup workspace event listeners */
export async function cleanupWorkspaceEventListeners(): Promise<void> {
  for (const unlisten of unlistenFunctions) {
    unlisten();
  }
  unlistenFunctions = [];
}

// =============================================================================
// Selectors
// =============================================================================

export const selectFileTree = (state: WorkspaceStore) => state.fileTree;
export const selectIsScanning = (state: WorkspaceStore) => state.isScanning;
export const selectRegisteringPathCounts = (state: WorkspaceStore) => state.registeringPathCounts;
export const selectScanResult = (state: WorkspaceStore) => state.scanResult;
export const selectWorkspaceError = (state: WorkspaceStore) => state.error;
