/**
 * Workspace Store
 *
 * Manages workspace file tree state, scanning, and file watching.
 * Provides workspace-based asset discovery and filesystem operations.
 */

import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { FileTreeEntry, WorkspaceScanResult } from '@/types';
import { createLogger } from '@/services/logger';
import {
  fetchWorkspaceTreeFromBackend,
  scanWorkspaceFromBackend,
  createFolderInBackend,
  renameFileInBackend,
  moveFileInBackend,
  deleteFileInBackend,
} from '@/services/workspaceGateway';
import {
  parseWorkspaceFileEvent,
  parseWorkspaceScanCompleteEvent,
} from '@/schemas/workspaceSchemas';
import { refreshProjectState, applyProjectState } from '@/utils/stateRefreshHelper';

const logger = createLogger('WorkspaceStore');

const TREE_REFRESH_COALESCE_MS = 120;

let nextTreeRefreshRequestId = 0;
let latestTreeRefreshRequestId = 0;
let scheduledTreeRefreshTimer: ReturnType<typeof setTimeout> | null = null;

// =============================================================================
// Types
// =============================================================================

interface WorkspaceState {
  /** Workspace file tree (hierarchical) */
  fileTree: FileTreeEntry[];
  /** Whether a scan is in progress */
  isScanning: boolean;
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
  /** Create a new folder in the workspace */
  createFolder: (relativePath: string) => Promise<void>;
  /** Rename a file or folder in the workspace */
  renameFile: (oldRelativePath: string, newName: string) => Promise<void>;
  /** Move a file or folder to a different directory */
  moveFile: (sourcePath: string, destFolderPath: string) => Promise<void>;
  /** Delete a file or folder from the workspace */
  deleteFile: (relativePath: string) => Promise<void>;
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
  isWatching: false,
  scanResult: null,
  error: null,
};

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Sync project store after a filesystem mutation (rename, move, delete).
 * These operations update asset paths on the backend, so we must refresh
 * the project store to keep frontend asset data consistent.
 */
async function syncProjectStoreAfterMutation(operation: string): Promise<void> {
  try {
    const freshState = await refreshProjectState();
    const { useProjectStore } = await import('@/stores/projectStore');
    useProjectStore.setState((draft) => {
      applyProjectState(draft, freshState);
    });
  } catch (syncError) {
    logger.warn(`Failed to sync project store after ${operation}`, {
      error: toErrorMessage(syncError),
    });
  }
}

function scheduleWorkspaceTreeRefresh(reason: string): void {
  if (scheduledTreeRefreshTimer !== null) {
    logger.debug('Coalescing workspace tree refresh request', { reason });
    return;
  }

  scheduledTreeRefreshTimer = setTimeout(() => {
    scheduledTreeRefreshTimer = null;
    void useWorkspaceStore.getState().refreshTree();
  }, TREE_REFRESH_COALESCE_MS);
}

function clearScheduledWorkspaceTreeRefresh(): void {
  if (scheduledTreeRefreshTimer !== null) {
    clearTimeout(scheduledTreeRefreshTimer);
    scheduledTreeRefreshTimer = null;
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
        const result = await scanWorkspaceFromBackend();
        logger.info('Workspace scan complete', {
          totalFiles: result.totalFiles,
          newFiles: result.newFiles,
          autoRegisteredFiles: result.autoRegisteredFiles,
        });

        set((state) => {
          state.scanResult = result;
          state.isScanning = false;
        });

        // Refresh tree after scan
        await get().refreshTree();

        // When auto-registration created new assets, sync project store.
        // We import useProjectStore lazily to avoid a circular dependency
        // (projectStore already imports workspaceStore).
        if (result.autoRegisteredFiles > 0) {
          try {
            const freshState = await refreshProjectState();
            const { useProjectStore } = await import('@/stores/projectStore');
            useProjectStore.setState((draft) => {
              applyProjectState(draft, freshState);
            });
            logger.info('Project store synced after auto-registration', {
              autoRegisteredFiles: result.autoRegisteredFiles,
            });
          } catch (syncError) {
            logger.warn('Failed to sync project store after auto-registration', {
              error: toErrorMessage(syncError),
            });
          }
        }
      } catch (error) {
        const message = toErrorMessage(error);
        logger.error('Workspace scan failed', { error: message });
        set((state) => {
          state.isScanning = false;
          state.error = message;
        });
      }
    },

    refreshTree: async () => {
      const requestId = ++nextTreeRefreshRequestId;
      latestTreeRefreshRequestId = requestId;

      const timerLabel = `workspace.refreshTree.${requestId}`;
      logger.time(timerLabel);

      try {
        const tree = await fetchWorkspaceTreeFromBackend();

        if (requestId !== latestTreeRefreshRequestId) {
          logger.warn('Discarding stale workspace tree response', {
            requestId,
            latestTreeRefreshRequestId,
          });
          return;
        }

        set((state) => {
          state.fileTree = tree;
          state.error = null;
        });
      } catch (error) {
        const message = toErrorMessage(error);
        logger.error('Failed to refresh workspace tree', { error: message });
        set((state) => {
          state.error = message;
        });
      } finally {
        logger.timeEnd(timerLabel);
      }
    },

    createFolder: async (relativePath: string) => {
      try {
        await createFolderInBackend(relativePath);
        await get().refreshTree();
      } catch (error) {
        const message = toErrorMessage(error);
        logger.error('Failed to create folder', { error: message });
        set((state) => {
          state.error = message;
        });
        throw error;
      }
    },

    renameFile: async (oldRelativePath: string, newName: string) => {
      try {
        await renameFileInBackend(oldRelativePath, newName);
        await get().refreshTree();
        await syncProjectStoreAfterMutation('renameFile');
      } catch (error) {
        const message = toErrorMessage(error);
        logger.error('Failed to rename file', { error: message });
        set((state) => {
          state.error = message;
        });
        throw error;
      }
    },

    moveFile: async (sourcePath: string, destFolderPath: string) => {
      try {
        await moveFileInBackend(sourcePath, destFolderPath);
        await get().refreshTree();
        await syncProjectStoreAfterMutation('moveFile');
      } catch (error) {
        const message = toErrorMessage(error);
        logger.error('Failed to move file', { error: message });
        set((state) => {
          state.error = message;
        });
        throw error;
      }
    },

    deleteFile: async (relativePath: string) => {
      try {
        await deleteFileInBackend(relativePath);
        await get().refreshTree();
        await syncProjectStoreAfterMutation('deleteFile');
      } catch (error) {
        const message = toErrorMessage(error);
        logger.error('Failed to delete file', { error: message });
        set((state) => {
          state.error = message;
        });
        throw error;
      }
    },

    reset: () => {
      nextTreeRefreshRequestId = 0;
      latestTreeRefreshRequestId = 0;
      clearScheduledWorkspaceTreeRefresh();
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

  const scopedUnlisteners: UnlistenFn[] = [];

  try {
    const unlistenFileAdded = await listen<unknown>('workspace:file-added', ({ payload }) => {
      try {
        const event = parseWorkspaceFileEvent(payload);
        logger.debug('Workspace file added event', { relativePath: event.relativePath });
        scheduleWorkspaceTreeRefresh('workspace:file-added');
      } catch (error) {
        logger.warn('Ignoring invalid workspace:file-added payload', {
          error: toErrorMessage(error),
        });
      }
    });
    scopedUnlisteners.push(unlistenFileAdded);

    const unlistenFileRemoved = await listen<unknown>('workspace:file-removed', ({ payload }) => {
      try {
        const event = parseWorkspaceFileEvent(payload);
        logger.debug('Workspace file removed event', { relativePath: event.relativePath });
        scheduleWorkspaceTreeRefresh('workspace:file-removed');
      } catch (error) {
        logger.warn('Ignoring invalid workspace:file-removed payload', {
          error: toErrorMessage(error),
        });
      }
    });
    scopedUnlisteners.push(unlistenFileRemoved);

    const unlistenFileModified = await listen<unknown>('workspace:file-modified', ({ payload }) => {
      try {
        const event = parseWorkspaceFileEvent(payload);
        logger.debug('Workspace file modified event', { relativePath: event.relativePath });
        scheduleWorkspaceTreeRefresh('workspace:file-modified');
      } catch (error) {
        logger.warn('Ignoring invalid workspace:file-modified payload', {
          error: toErrorMessage(error),
        });
      }
    });
    scopedUnlisteners.push(unlistenFileModified);

    const unlistenScanComplete = await listen<unknown>('workspace:scan-complete', ({ payload }) => {
      try {
        const event = parseWorkspaceScanCompleteEvent(payload);

        logger.info('Workspace scan complete event', {
          totalFiles: event.totalFiles,
          newFiles: event.newFiles,
          removedFiles: event.removedFiles,
          registeredFiles: event.registeredFiles,
          autoRegisteredFiles: event.autoRegisteredFiles,
        });

        useWorkspaceStore.setState({
          scanResult: event,
          isScanning: false,
          error: null,
        });

        scheduleWorkspaceTreeRefresh('workspace:scan-complete');

        // Sync project store when new assets were auto-registered
        if (event.autoRegisteredFiles > 0) {
          refreshProjectState()
            .then(async (freshState) => {
              const { useProjectStore } = await import('@/stores/projectStore');
              useProjectStore.setState((draft) => {
                applyProjectState(draft, freshState);
              });
            })
            .catch((syncError) => {
              logger.warn('Failed to sync project store after scan-complete event', {
                error: toErrorMessage(syncError),
              });
            });
        }
      } catch (error) {
        logger.warn('Ignoring invalid workspace:scan-complete payload', {
          error: toErrorMessage(error),
        });
      }
    });
    scopedUnlisteners.push(unlistenScanComplete);

    unlistenFunctions = scopedUnlisteners;
    useWorkspaceStore.setState({
      isWatching: true,
      error: null,
    });

    logger.info('Workspace event listeners setup');
  } catch (error) {
    for (const unlisten of scopedUnlisteners) {
      try {
        unlisten();
      } catch {
        // Ignore cleanup errors in setup rollback.
      }
    }

    const message = toErrorMessage(error);
    useWorkspaceStore.setState({
      isWatching: false,
      error: message,
    });

    logger.error('Failed to setup workspace event listeners', { error: message });
    throw error;
  }
}

/** Cleanup workspace event listeners */
export async function cleanupWorkspaceEventListeners(): Promise<void> {
  for (const unlisten of unlistenFunctions) {
    try {
      unlisten();
    } catch (error) {
      logger.warn('Failed to clean up workspace listener', {
        error: toErrorMessage(error),
      });
    }
  }
  unlistenFunctions = [];
  clearScheduledWorkspaceTreeRefresh();
  useWorkspaceStore.setState({ isWatching: false });
}

// =============================================================================
// Selectors
// =============================================================================

export const selectFileTree = (state: WorkspaceStore) => state.fileTree;
export const selectIsScanning = (state: WorkspaceStore) => state.isScanning;
export const selectScanResult = (state: WorkspaceStore) => state.scanResult;
export const selectWorkspaceError = (state: WorkspaceStore) => state.error;
