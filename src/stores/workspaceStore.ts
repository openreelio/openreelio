/**
 * Workspace Store
 *
 * Manages workspace file tree state, scanning, and file watching.
 * Provides workspace-based asset discovery and registration.
 */

import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { FileTreeEntry, WorkspaceScanResult, RegisterFileResult } from '@/types';
import { createLogger } from '@/services/logger';
import {
  fetchWorkspaceTreeFromBackend,
  parseRelativeWorkspacePath,
  parseRelativeWorkspacePathList,
  registerWorkspaceFileInBackend,
  registerWorkspaceFilesInBackend,
  scanWorkspaceFromBackend,
} from '@/services/workspaceGateway';
import {
  parseWorkspaceFileEvent,
  parseWorkspaceScanCompleteEvent,
} from '@/schemas/workspaceSchemas';

const logger = createLogger('WorkspaceStore');

const TREE_REFRESH_DEBOUNCE_MS = 120;

let nextTreeRefreshRequestId = 0;
let latestTreeRefreshRequestId = 0;
let scheduledTreeRefreshTimer: ReturnType<typeof setTimeout> | null = null;

const inFlightSingleFileRegistrations = new Map<string, Promise<RegisterFileResult | null>>();

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

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function scheduleWorkspaceTreeRefresh(reason: string): void {
  if (scheduledTreeRefreshTimer !== null) {
    logger.debug('Coalescing workspace tree refresh request', { reason });
    return;
  }

  scheduledTreeRefreshTimer = setTimeout(() => {
    scheduledTreeRefreshTimer = null;
    void useWorkspaceStore.getState().refreshTree();
  }, TREE_REFRESH_DEBOUNCE_MS);
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
        });

        set((state) => {
          state.scanResult = result;
          state.isScanning = false;
        });

        // Refresh tree after scan
        await get().refreshTree();
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

    registerFile: async (relativePath: string) => {
      let normalizedPath: string;
      try {
        normalizedPath = parseRelativeWorkspacePath(relativePath);
      } catch (error) {
        const message = toErrorMessage(error);
        set((state) => {
          state.error = message;
        });
        return null;
      }

      const inFlight = inFlightSingleFileRegistrations.get(normalizedPath);
      if (inFlight) {
        logger.debug('Reusing in-flight workspace registration', { relativePath: normalizedPath });
        return inFlight;
      }

      const registrationPromise = (async () => {
        set((state) => {
          beginRegistration(state.registeringPathCounts, [normalizedPath]);
          state.error = null;
        });

        try {
          const result = await registerWorkspaceFileInBackend(normalizedPath);
          logger.info('Registered workspace file', {
            relativePath: result.relativePath,
            assetId: result.assetId,
          });

          // Refresh tree to update registration status
          await get().refreshTree();
          return result;
        } catch (error) {
          const message = toErrorMessage(error);
          logger.error('Failed to register workspace file', { error: message });
          set((state) => {
            state.error = message;
          });
          return null;
        } finally {
          set((state) => {
            completeRegistration(state.registeringPathCounts, [normalizedPath]);
          });
          inFlightSingleFileRegistrations.delete(normalizedPath);
        }
      })();

      inFlightSingleFileRegistrations.set(normalizedPath, registrationPromise);
      return registrationPromise;
    },

    registerFiles: async (relativePaths: string[]) => {
      let normalizedPaths: string[];
      try {
        normalizedPaths = parseRelativeWorkspacePathList(relativePaths);
      } catch (error) {
        const message = toErrorMessage(error);
        logger.error('Invalid workspace registration batch', { error: message });
        set((state) => {
          state.error = message;
        });
        return [];
      }

      if (normalizedPaths.length === 0) {
        return [];
      }

      set((state) => {
        beginRegistration(state.registeringPathCounts, normalizedPaths);
        state.error = null;
      });

      try {
        const results = await registerWorkspaceFilesInBackend(normalizedPaths);
        logger.info('Registered workspace files', {
          requestedCount: normalizedPaths.length,
          importedCount: results.length,
        });

        // Refresh tree to update registration status
        await get().refreshTree();
        return results;
      } catch (error) {
        const message = toErrorMessage(error);
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
      inFlightSingleFileRegistrations.clear();
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
        });

        useWorkspaceStore.setState({
          scanResult: event,
          isScanning: false,
          error: null,
        });

        scheduleWorkspaceTreeRefresh('workspace:scan-complete');
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
export const selectRegisteringPathCounts = (state: WorkspaceStore) => state.registeringPathCounts;
export const selectScanResult = (state: WorkspaceStore) => state.scanResult;
export const selectWorkspaceError = (state: WorkspaceStore) => state.error;
