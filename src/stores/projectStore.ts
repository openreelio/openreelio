/**
 * Project Store
 *
 * Manages project state including assets, sequences, and project metadata.
 * Uses Zustand with Immer for immutable state updates.
 *
 * Architecture Notes:
 * - Uses command queue to serialize async operations and prevent race conditions
 * - State version tracking enables optimistic updates with conflict detection
 * - All IPC calls are serialized through the queue to ensure consistency
 */

import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { enableMapSet } from 'immer';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type {
  Asset,
  Command,
  CommandResult,
  Effect,
  ProxyStatus,
  Sequence,
  UndoRedoResult,
  WaveformData,
} from '@/types';
import { createLogger } from '@/services/logger';
// Direct imports instead of barrel to avoid bundling all utilities
import {
  commandQueue,
  _resetCommandQueueForTesting as resetCommandQueue,
} from '@/utils/commandQueue';
import {
  requestDeduplicator,
  _resetDeduplicatorForTesting as resetDeduplicator,
} from '@/utils/requestDeduplicator';
import { refreshProjectState, applyProjectState } from '@/utils/stateRefreshHelper';
import { useWorkspaceStore, setupWorkspaceEventListeners } from '@/stores/workspaceStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useCommandPaletteStore } from '@/stores/commandPaletteStore';
import { cleanupTerminalSessions } from '@/stores/terminalStore';
import {
  configureProjectMutationGateway,
  type ProjectBackendMutationOptions,
} from '@/services/projectMutationGateway';

const logger = createLogger('ProjectStore');

function shouldAutoScanWorkspaceOnOpen(): boolean {
  const workspaceSettings = useSettingsStore.getState().settings.workspace;
  return workspaceSettings?.autoScanOnOpen ?? true;
}

// =============================================================================
// Test Utilities
// =============================================================================

/**
 * Resets the command queue and deduplicator state.
 * FOR TESTING ONLY - do not use in production code.
 */
export function _resetCommandQueueForTesting(): void {
  resetCommandQueue();
  resetDeduplicator();
}

// =============================================================================
// Proxy Event Types
// =============================================================================

interface ProxyGeneratingEvent {
  assetId: string;
  jobId: string;
}

interface ProxyReadyEvent {
  assetId: string;
  proxyPath: string;
  proxyUrl: string;
}

interface ProxyFailedEvent {
  assetId: string;
  error: string;
}

// Enable Immer's MapSet plugin for Map/Set support
enableMapSet();

// =============================================================================
// Types
// =============================================================================

interface ProjectMeta {
  id: string;
  name: string;
  path: string;
  createdAt: string;
  modifiedAt: string;
  /** Format version: 1 = legacy (import-only), 2 = workspace-enabled */
  formatVersion?: number;
}

interface ProjectState {
  // State
  isLoaded: boolean;
  isLoading: boolean;
  isDirty: boolean;
  meta: ProjectMeta | null;
  assets: Map<string, Asset>;
  sequences: Map<string, Sequence>;
  effects: Map<string, Effect>;
  activeSequenceId: string | null;
  /** Navigation stack for compound clip sequence drilling (parent → child) */
  sequenceNavigationStack: string[];
  selectedAssetId: string | null;
  proxyJobIdsByAssetId: Record<string, string>;
  error: string | null;
  /** State version for conflict detection (increments on each state update) */
  stateVersion: number;

  // Actions
  loadProject: (path: string) => Promise<void>;
  createProject: (name: string, path: string) => Promise<void>;
  openOrInitProject: (path: string) => Promise<void>;
  saveProject: () => Promise<void>;
  closeProject: () => Promise<void>;

  // Asset actions
  importAsset: (uri?: string) => Promise<string>;
  relinkAsset: (assetId: string, uri: string) => Promise<void>;
  removeAsset: (assetId: string) => Promise<void>;
  getAsset: (assetId: string) => Asset | undefined;
  selectAsset: (assetId: string | null) => void;
  generateAssetThumbnail: (assetId: string) => Promise<string | null>;
  loadWaveformData: (assetId: string) => Promise<WaveformData | null>;
  generateWaveformForAsset: (
    assetId: string,
    samplesPerSecond?: number,
  ) => Promise<WaveformData | null>;
  ensureAudioPreviewForAsset: (assetId: string) => Promise<string | null>;
  generateProxyForAsset: (assetId: string) => Promise<void>;
  cancelProxyForAsset: (assetId: string) => Promise<void>;
  useOriginalMedia: (assetId: string) => Promise<void>;
  updateAssetProxyStatus: (assetId: string, status: ProxyStatus, proxyUrl?: string) => void;

  // Sequence actions
  createSequence: (name: string, format: string) => Promise<string>;
  setActiveSequence: (sequenceId: string) => void;
  getActiveSequence: () => Sequence | undefined;
  /** Navigate into a compound clip's inner sequence */
  pushSequence: (sequenceId: string) => void;
  /** Navigate back to the parent sequence */
  popSequence: () => void;

  // Command execution
  executeCommand: (command: Command) => Promise<CommandResult>;
  executeBackendMutation: <T>(
    operationName: string,
    mutation: () => Promise<T>,
    options?: ProjectBackendMutationOptions,
  ) => Promise<T>;
  refreshFromBackendMutation: () => Promise<number>;
  undo: () => Promise<UndoRedoResult>;
  redo: () => Promise<UndoRedoResult>;
  jumpToHistoryState: (targetIndex: number) => Promise<UndoRedoResult>;
  canUndo: () => Promise<boolean>;
  canRedo: () => Promise<boolean>;
}

// =============================================================================
// Store
// =============================================================================

export const useProjectStore = create<ProjectState>()(
  immer((set, get) => ({
    // Initial state
    isLoaded: false,
    isLoading: false,
    isDirty: false,
    meta: null,
    assets: new Map(),
    sequences: new Map(),
    effects: new Map(),
    activeSequenceId: null,
    sequenceNavigationStack: [],
    selectedAssetId: null,
    proxyJobIdsByAssetId: {},
    error: null,
    stateVersion: 0,

    // Load existing project
    loadProject: async (path: string) => {
      set((state) => {
        state.isLoading = true;
        state.error = null;
      });

      try {
        const projectInfo = await invoke<ProjectMeta>('open_project', { path });

        // Load full project state including assets, sequences, and bins
        const projectState = await refreshProjectState();

        set((state) => {
          state.isLoaded = true;
          state.isLoading = false;
          state.meta = projectInfo;
          state.isDirty = false;
          state.selectedAssetId = null;
          state.proxyJobIdsByAssetId = {};
          state.sequenceNavigationStack = [];

          // Populate assets
          state.assets = projectState.assets;

          // Populate sequences
          state.sequences = projectState.sequences;

          // Populate effects
          state.effects = projectState.effects ?? new Map();

          // Set active sequence
          state.activeSequenceId = projectState.activeSequenceId;
        });

        // Initialize workspace: setup event listeners and auto-scan
        setupWorkspaceEventListeners();
        if (shouldAutoScanWorkspaceOnOpen()) {
          // Capture project identity + state version so a slow auto-scan cannot
          // apply its result over a different project: the user may close this
          // project or open another one before the scan resolves.
          const scanProjectId = projectInfo.id;
          const scanStateVersion = get().stateVersion;
          useWorkspaceStore
            .getState()
            .scanWorkspace()
            .then(async () => {
              try {
                const freshState = await refreshProjectState();
                set((state) => {
                  if (
                    state.meta?.id !== scanProjectId ||
                    state.stateVersion !== scanStateVersion
                  ) {
                    return;
                  }
                  applyProjectState(state, freshState);
                });
              } catch (syncError) {
                logger.warn('Workspace auto-scan completed but project state sync failed', {
                  error: String(syncError),
                });
              }
            })
            .catch((err) => {
              logger.warn('Workspace auto-scan failed', { error: String(err) });
            });
        }
      } catch (error) {
        set((state) => {
          state.isLoading = false;
          state.error = error instanceof Error ? error.message : String(error);
        });
        throw error;
      }
    },

    // Create new project
    createProject: async (name: string, path: string) => {
      set((state) => {
        state.isLoading = true;
        state.error = null;
      });

      try {
        // Create project on backend - this also creates default sequence via Command
        const projectInfo = await invoke<ProjectMeta>('create_project', { name, path });

        // Load full project state to get default sequence and tracks
        // This is a single atomic operation - if it fails, the project creation is considered failed
        const projectState = await refreshProjectState();

        // Only update store if both operations succeeded
        set((state) => {
          state.isLoaded = true;
          state.isLoading = false;
          state.meta = projectInfo;
          state.selectedAssetId = null;
          state.proxyJobIdsByAssetId = {};
          state.isDirty = false;
          state.sequenceNavigationStack = [];

          // Populate assets (empty for new project)
          state.assets = projectState.assets;

          // Populate sequences (includes default sequence with tracks)
          state.sequences = projectState.sequences;

          // Populate effects
          state.effects = projectState.effects ?? new Map();

          // Set active sequence
          state.activeSequenceId = projectState.activeSequenceId;
        });

        // Initialize workspace event listeners for new project
        setupWorkspaceEventListeners();
      } catch (error) {
        // Reset to clean state on any failure
        set((state) => {
          state.isLoading = false;
          state.isLoaded = false;
          state.meta = null;
          state.assets = new Map();
          state.sequences = new Map();
          state.effects = new Map();
          state.activeSequenceId = null;
          state.sequenceNavigationStack = [];
          state.selectedAssetId = null;
          state.proxyJobIdsByAssetId = {};
          state.error = error instanceof Error ? error.message : String(error);
        });
        throw error;
      }
    },

    // Open folder as project (initialize if needed)
    openOrInitProject: async (path: string) => {
      set((state) => {
        state.isLoading = true;
        state.error = null;
      });

      try {
        const projectInfo = await invoke<ProjectMeta>('open_or_init_project', { path });

        // Load full project state including assets, sequences, and bins
        const projectState = await refreshProjectState();

        set((state) => {
          state.isLoaded = true;
          state.isLoading = false;
          state.meta = projectInfo;
          state.isDirty = false;
          state.selectedAssetId = null;
          state.proxyJobIdsByAssetId = {};
          state.sequenceNavigationStack = [];

          // Populate assets
          state.assets = projectState.assets;

          // Populate sequences
          state.sequences = projectState.sequences;

          // Populate effects
          state.effects = projectState.effects ?? new Map();

          // Set active sequence
          state.activeSequenceId = projectState.activeSequenceId;
        });

        // Initialize workspace: setup event listeners and auto-scan
        setupWorkspaceEventListeners();
        if (shouldAutoScanWorkspaceOnOpen()) {
          // Capture project identity + state version so a slow auto-scan cannot
          // apply its result over a different project: the user may close this
          // project or open another one before the scan resolves.
          const scanProjectId = projectInfo.id;
          const scanStateVersion = get().stateVersion;
          useWorkspaceStore
            .getState()
            .scanWorkspace()
            .then(async () => {
              try {
                const freshState = await refreshProjectState();
                set((state) => {
                  if (
                    state.meta?.id !== scanProjectId ||
                    state.stateVersion !== scanStateVersion
                  ) {
                    return;
                  }
                  applyProjectState(state, freshState);
                });
              } catch (syncError) {
                logger.warn('Workspace auto-scan completed but project state sync failed', {
                  error: String(syncError),
                });
              }
            })
            .catch((err) => {
              logger.warn('Workspace auto-scan failed', { error: String(err) });
            });
        }
      } catch (error) {
        set((state) => {
          state.isLoading = false;
          state.error = error instanceof Error ? error.message : String(error);
        });
        throw error;
      }
    },

    // Save project
    saveProject: async () => {
      try {
        await invoke('save_project');
        set((state) => {
          state.isDirty = false;
          if (state.meta) {
            state.meta.modifiedAt = new Date().toISOString();
          }
        });
      } catch (error) {
        set((state) => {
          state.error = error instanceof Error ? error.message : String(error);
        });
        throw error;
      }
    },

    // Close project
    closeProject: async () => {
      // Clear command queue to prevent any pending operations from affecting the next project
      commandQueue.clear();

      // Close the project on the backend first.
      // Use require_saved=false because the frontend already handles
      // save/discard confirmation via UnsavedChangesDialog before calling this.
      try {
        await invoke('close_project', { requireSaved: false });
      } catch (error) {
        // Log but don't block frontend cleanup — the user already decided to close.
        logger.warn('Backend close_project failed, clearing frontend state anyway', { error });
      }

      set((state) => {
        state.isLoaded = false;
        state.isLoading = false;
        state.meta = null;
        state.assets = new Map();
        state.sequences = new Map();
        state.effects = new Map();
        state.activeSequenceId = null;
        state.sequenceNavigationStack = [];
        state.selectedAssetId = null;
        state.proxyJobIdsByAssetId = {};
        state.isDirty = false;
        state.error = null;
        // Increment (not reset) so in-flight ops from the old project
        // see a version mismatch and abort instead of applying stale state.
        state.stateVersion += 1;
      });
      useCommandPaletteStore.getState().close();

      try {
        const cleanedUp = await cleanupTerminalSessions();
        if (!cleanedUp) {
          logger.warn('Some terminal sessions could not be closed during project close');
        }
      } catch (error) {
        logger.warn('Terminal cleanup failed during project close', { error });
      }

      logger.info('Project closed and state reset');
    },

    // Import asset
    importAsset: async (uri?: string) => {
      if (!uri) {
        const message = 'Asset URI is required';
        set((state) => {
          state.error = message;
        });
        throw new Error(message);
      }

      try {
        const result = await invoke<{ assetId: string; name: string }>('import_asset', { uri });

        // Fetch full asset list to get the newly imported asset
        const assets = await invoke<Asset[]>('get_assets');

        set((state) => {
          state.isDirty = true;
          state.selectedAssetId = result.assetId;

          // Update all assets in store
          state.assets = new Map();
          for (const asset of assets) {
            state.assets.set(asset.id, asset);
          }
        });

        // Generate thumbnail in background (don't await - fire and forget)
        invoke<string | null>('generate_asset_thumbnail', { assetId: result.assetId })
          .then((thumbnailUrl) => {
            if (thumbnailUrl) {
              set((state) => {
                const asset = state.assets.get(result.assetId);
                if (asset) {
                  asset.thumbnailUrl = thumbnailUrl;
                }
              });
            }
          })
          .catch((err) => {
            logger.warn('Thumbnail generation failed', { error: err });
          });

        return result.assetId;
      } catch (error) {
        set((state) => {
          state.error = error instanceof Error ? error.message : String(error);
        });
        throw error;
      }
    },

    // Relink or replace an existing asset source while preserving its asset ID
    relinkAsset: async (assetId: string, uri: string) => {
      if (!uri) {
        const message = 'Replacement asset URI is required';
        set((state) => {
          state.error = message;
        });
        throw new Error(message);
      }

      try {
        await invoke('relink_asset', { assetId, uri });

        const assets = await invoke<Asset[]>('get_assets');

        set((state) => {
          state.isDirty = true;
          state.selectedAssetId = assetId;
          state.assets = new Map();
          for (const asset of assets) {
            state.assets.set(asset.id, asset);
          }
        });

        invoke<string | null>('generate_asset_thumbnail', { assetId })
          .then((thumbnailUrl) => {
            if (thumbnailUrl) {
              set((state) => {
                const asset = state.assets.get(assetId);
                if (asset) {
                  asset.thumbnailUrl = thumbnailUrl;
                }
              });
            }
          })
          .catch((err) => {
            logger.warn('Thumbnail generation failed after asset relink', { assetId, error: err });
          });

        useWorkspaceStore
          .getState()
          .refreshTree()
          .catch((err) => {
            logger.warn('Failed to refresh workspace tree after asset relink', {
              assetId,
              error: String(err),
            });
          });
      } catch (error) {
        set((state) => {
          state.error = error instanceof Error ? error.message : String(error);
        });
        throw error;
      }
    },

    // Remove asset
    removeAsset: async (assetId: string) => {
      try {
        await invoke('remove_asset', { assetId });

        set((state) => {
          state.assets.delete(assetId);
          state.isDirty = true;
          if (state.selectedAssetId === assetId) {
            state.selectedAssetId = null;
          }
        });

        // Sync Files tab registration indicators after backend index updates.
        useWorkspaceStore
          .getState()
          .refreshTree()
          .catch((err) => {
            logger.warn('Failed to refresh workspace tree after asset removal', {
              assetId,
              error: String(err),
            });
          });
      } catch (error) {
        set((state) => {
          state.error = error instanceof Error ? error.message : String(error);
        });
        throw error;
      }
    },

    // Get asset by ID
    getAsset: (assetId: string) => {
      return get().assets.get(assetId);
    },

    // Select asset
    selectAsset: (assetId: string | null) => {
      set((state) => {
        state.selectedAssetId = assetId;
      });
    },

    generateAssetThumbnail: async (assetId: string) => {
      const thumbnailUrl = await invoke<string | null>('generate_asset_thumbnail', { assetId });

      if (thumbnailUrl) {
        set((state) => {
          const asset = state.assets.get(assetId);
          if (asset) {
            asset.thumbnailUrl = thumbnailUrl;
          }
        });
      }

      return thumbnailUrl;
    },

    loadWaveformData: async (assetId: string) => {
      return invoke<WaveformData | null>('get_waveform_data', { assetId });
    },

    generateWaveformForAsset: async (assetId: string, samplesPerSecond = 100) => {
      return invoke<WaveformData | null>('generate_waveform_for_asset', {
        assetId,
        samplesPerSecond,
      });
    },

    ensureAudioPreviewForAsset: async (assetId: string) => {
      return invoke<string | null>('ensure_audio_preview_for_asset', { assetId });
    },

    generateProxyForAsset: async (assetId: string) => {
      try {
        set((state) => {
          const asset = state.assets.get(assetId);
          if (asset) {
            asset.proxyStatus = 'pending';
          }
        });

        const proxyUrl = await invoke<string | null>('generate_proxy_for_asset', { assetId });
        if (proxyUrl) {
          set((state) => {
            const asset = state.assets.get(assetId);
            if (asset) {
              asset.proxyStatus = 'ready';
              asset.proxyUrl = proxyUrl;
            }
          });
        }
      } catch (error) {
        set((state) => {
          const asset = state.assets.get(assetId);
          if (asset) {
            asset.proxyStatus = 'failed';
          }
          state.error = error instanceof Error ? error.message : String(error);
        });
        throw error;
      }
    },

    cancelProxyForAsset: async (assetId: string) => {
      const jobId = get().proxyJobIdsByAssetId[assetId];
      if (!jobId) {
        throw new Error('No cancellable proxy job for asset');
      }

      await invoke<boolean>('cancel_job', { jobId });
      await get().useOriginalMedia(assetId);
    },

    useOriginalMedia: async (assetId: string) => {
      await get().executeCommand({
        type: 'UpdateAsset',
        payload: {
          assetId,
          proxyStatus: 'notNeeded',
          proxyUrl: null,
        },
      });

      set((state) => {
        delete state.proxyJobIdsByAssetId[assetId];
      });
    },

    // Update asset proxy status (called by event listeners)
    updateAssetProxyStatus: (assetId: string, status: ProxyStatus, proxyUrl?: string) => {
      set((state) => {
        const asset = state.assets.get(assetId);
        if (asset) {
          asset.proxyStatus = status;
          if (proxyUrl) {
            asset.proxyUrl = proxyUrl;
          }
          logger.info('Asset proxy status updated', { assetId, status, proxyUrl });
        }
      });

      // Persist to backend
      invoke('update_asset_proxy', {
        assetId,
        proxyUrl: proxyUrl ?? null,
        proxyStatus: status,
      }).catch((err) => {
        logger.error('Failed to persist asset proxy status', { error: err });
      });
    },

    // Create sequence
    createSequence: async (name: string, format: string) => {
      try {
        const result = await invoke<Sequence>('create_sequence', { name, format });

        // Add the new sequence to store
        set((state) => {
          state.sequences.set(result.id, result);
          state.isDirty = true;
          state.sequenceNavigationStack = [];
          state.activeSequenceId = result.id;
        });

        return result.id;
      } catch (error) {
        set((state) => {
          state.error = error instanceof Error ? error.message : String(error);
        });
        throw error;
      }
    },

    // Set active sequence
    setActiveSequence: (sequenceId: string) => {
      set((state) => {
        if (state.sequences.has(sequenceId)) {
          // Switching root sequences exits local compound navigation.
          state.sequenceNavigationStack = [];
          state.activeSequenceId = sequenceId;
        }
      });
    },

    // Get active sequence
    getActiveSequence: () => {
      const state = get();
      if (!state.activeSequenceId) return undefined;
      return state.sequences.get(state.activeSequenceId);
    },

    // Navigate into a compound clip's inner sequence
    pushSequence: (sequenceId: string) => {
      set((state) => {
        if (state.sequences.has(sequenceId)) {
          if (state.activeSequenceId === sequenceId) {
            return;
          }
          if (state.activeSequenceId) {
            state.sequenceNavigationStack.push(state.activeSequenceId);
          }
          state.activeSequenceId = sequenceId;
        }
      });
    },

    // Navigate back to the parent sequence (skips deleted sequences, falls back to root)
    popSequence: () => {
      set((state) => {
        if (state.sequenceNavigationStack.length === 0) {
          return;
        }

        while (state.sequenceNavigationStack.length > 0) {
          const parentId = state.sequenceNavigationStack.pop()!;
          if (state.sequences.has(parentId)) {
            state.activeSequenceId = parentId;
            return;
          }
        }
        // Stack exhausted without finding a valid parent — fall back only when
        // the current active sequence also no longer exists.
        const firstSeqId = state.sequences.keys().next().value;
        if (
          firstSeqId &&
          (!state.activeSequenceId || !state.sequences.has(state.activeSequenceId))
        ) {
          state.activeSequenceId = firstSeqId;
        }
      });
    },

    /**
     * Execute edit command with race condition protection and deduplication.
     *
     * Uses command queue to serialize all command executions and state refreshes.
     * Uses request deduplication to prevent duplicate operations from double-clicks.
     * This prevents data loss when multiple commands are issued rapidly.
     *
     * Architecture:
     * - Commands are serialized through a FIFO queue (single concurrent execution)
     * - State version is captured atomically within the set() call
     * - Backend is the single source of truth; frontend state is refreshed after each command
     *
     * @param command - The command to execute
     * @returns CommandResult from backend
     */
    executeCommand: async (command: Command) => {
      // Deduplicate requests to prevent double-click issues
      return requestDeduplicator.execute(command.type, command.payload, () =>
        commandQueue.enqueue(async () => {
          // Capture version atomically before any async operation
          // This is safe because commandQueue ensures sequential execution
          const versionBefore = get().stateVersion;

          try {
            logger.debug('Executing command', { type: command.type, version: versionBefore });

            const result = await invoke<CommandResult>('execute_command', {
              commandType: command.type,
              payload: command.payload,
            });

            // Refresh state from backend to ensure consistency
            const freshState = await refreshProjectState();

            // Atomic state update with version check
            // The set() callback executes synchronously, ensuring atomicity
            let concurrentModificationDetected = false;
            set((state) => {
              // Double-check version hasn't changed (defensive programming)
              // This should never happen due to queue serialization, but provides an extra safety net
              if (state.stateVersion !== versionBefore) {
                concurrentModificationDetected = true;
                logger.error('Concurrent modification detected in set() callback', {
                  commandType: command.type,
                  expectedVersion: versionBefore,
                  actualVersion: state.stateVersion,
                });
                return; // Don't apply state changes
              }

              state.isDirty = true;
              state.stateVersion += 1;
              state.error = null;
              applyProjectState(state, freshState);
            });

            if (concurrentModificationDetected) {
              throw new Error(
                `Concurrent modification detected during command execution. ` +
                  `State version changed unexpectedly. Please retry the operation.`,
              );
            }

            logger.debug('Command executed successfully', {
              type: command.type,
              newVersion: get().stateVersion,
            });

            return result;
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            logger.error('Command execution failed', { type: command.type, error: errorMessage });

            set((state) => {
              state.error = errorMessage;
            });
            throw error;
          }
        }, `executeCommand:${command.type}`),
      );
    },

    executeBackendMutation: async <T>(
      operationName: string,
      mutation: () => Promise<T>,
      options?: ProjectBackendMutationOptions,
    ): Promise<T> => {
      const shouldRefresh = options?.refreshProjectState ?? true;
      const shouldMarkDirty = options?.markDirty ?? shouldRefresh;

      return commandQueue.enqueue(
        async () => {
          const versionBefore = get().stateVersion;

          try {
            logger.debug('Executing backend mutation', { operationName, version: versionBefore });
            const result = await mutation();

            if (!shouldRefresh) {
              set((state) => {
                state.error = null;
                if (shouldMarkDirty) {
                  state.isDirty = true;
                }
              });
              return result;
            }

            const freshState = await refreshProjectState();

            let concurrentModificationDetected = false;
            set((state) => {
              if (state.stateVersion !== versionBefore) {
                concurrentModificationDetected = true;
                logger.error('Concurrent modification detected during backend mutation', {
                  operationName,
                  expectedVersion: versionBefore,
                  actualVersion: state.stateVersion,
                });
                return;
              }

              state.isDirty = shouldMarkDirty || state.isDirty;
              state.stateVersion += 1;
              state.error = null;
              applyProjectState(state, freshState);
            });

            if (concurrentModificationDetected) {
              throw new Error(
                'Concurrent modification detected during backend mutation. Please retry the operation.',
              );
            }

            logger.debug('Backend mutation completed', {
              operationName,
              newVersion: get().stateVersion,
            });

            return result;
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            logger.error('Backend mutation failed', { operationName, error: errorMessage });

            set((state) => {
              state.error = errorMessage;
            });
            throw error;
          }
        },
        operationName,
        { timeoutMs: options?.timeoutMs },
      );
    },

    refreshFromBackendMutation: async () => {
      return commandQueue.enqueue(async () => {
        const versionBefore = get().stateVersion;

        try {
          logger.debug('Refreshing store after backend mutation', { version: versionBefore });
          const freshState = await refreshProjectState();

          let concurrentModificationDetected = false;
          let nextStateVersion = versionBefore;
          set((state) => {
            if (state.stateVersion !== versionBefore) {
              concurrentModificationDetected = true;
              logger.error('Concurrent modification detected during backend mutation refresh', {
                expectedVersion: versionBefore,
                actualVersion: state.stateVersion,
              });
              return;
            }

            state.isDirty = true;
            state.stateVersion += 1;
            nextStateVersion = state.stateVersion;
            state.error = null;
            applyProjectState(state, freshState);
          });

          if (concurrentModificationDetected) {
            throw new Error(
              'Concurrent modification detected during backend mutation refresh. Please retry the operation.',
            );
          }

          logger.debug('Backend mutation refresh completed', { newVersion: nextStateVersion });
          return nextStateVersion;
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          logger.error('Backend mutation refresh failed', { error: errorMessage });

          set((state) => {
            state.error = errorMessage;
          });
          throw error;
        }
      }, 'refreshFromBackendMutation');
    },

    /**
     * Undo last command with race condition protection.
     * Uses command queue to prevent conflicts with concurrent operations.
     */
    undo: async () => {
      return commandQueue.enqueue(async () => {
        const versionBefore = get().stateVersion;

        try {
          logger.debug('Executing undo', { version: versionBefore });
          const result = await invoke<UndoRedoResult>('undo');

          // Refresh state from backend after undo
          const freshState = await refreshProjectState();

          let concurrentModificationDetected = false;
          set((state) => {
            if (state.stateVersion !== versionBefore) {
              concurrentModificationDetected = true;
              logger.error('Concurrent modification detected in set() callback', {
                operation: 'undo',
                expectedVersion: versionBefore,
                actualVersion: state.stateVersion,
              });
              return;
            }

            state.isDirty = true;
            state.stateVersion += 1;
            state.error = null;
            applyProjectState(state, freshState);
          });

          if (concurrentModificationDetected) {
            throw new Error(
              'Concurrent modification detected during undo. Please retry the operation.',
            );
          }

          logger.debug('Undo completed', { newVersion: get().stateVersion });
          return result;
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          logger.error('Undo failed', { error: errorMessage });

          set((state) => {
            state.error = errorMessage;
          });
          throw error;
        }
      }, 'undo');
    },

    /**
     * Redo last undone command with race condition protection.
     * Uses command queue to prevent conflicts with concurrent operations.
     */
    redo: async () => {
      return commandQueue.enqueue(async () => {
        const versionBefore = get().stateVersion;

        try {
          logger.debug('Executing redo', { version: versionBefore });
          const result = await invoke<UndoRedoResult>('redo');

          // Refresh state from backend after redo
          const freshState = await refreshProjectState();

          let concurrentModificationDetected = false;
          set((state) => {
            if (state.stateVersion !== versionBefore) {
              concurrentModificationDetected = true;
              logger.error('Concurrent modification detected in set() callback', {
                operation: 'redo',
                expectedVersion: versionBefore,
                actualVersion: state.stateVersion,
              });
              return;
            }

            state.isDirty = true;
            state.stateVersion += 1;
            state.error = null;
            applyProjectState(state, freshState);
          });

          if (concurrentModificationDetected) {
            throw new Error(
              'Concurrent modification detected during redo. Please retry the operation.',
            );
          }

          logger.debug('Redo completed', { newVersion: get().stateVersion });
          return result;
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          logger.error('Redo failed', { error: errorMessage });

          set((state) => {
            state.error = errorMessage;
          });
          throw error;
        }
      }, 'redo');
    },

    /**
     * Jump to a specific state in the undo history with the same queue/version
     * guarantees as undo/redo.
     */
    jumpToHistoryState: async (targetIndex: number) => {
      return commandQueue.enqueue(async () => {
        const versionBefore = get().stateVersion;

        try {
          logger.debug('Jumping to history state', { targetIndex, version: versionBefore });
          const result = await invoke<UndoRedoResult>('jump_to_history_state', { targetIndex });

          const freshState = await refreshProjectState();

          let concurrentModificationDetected = false;
          set((state) => {
            if (state.stateVersion !== versionBefore) {
              concurrentModificationDetected = true;
              logger.error('Concurrent modification detected in set() callback', {
                operation: 'jumpToHistoryState',
                targetIndex,
                expectedVersion: versionBefore,
                actualVersion: state.stateVersion,
              });
              return;
            }

            state.isDirty = true;
            state.stateVersion += 1;
            state.error = null;
            applyProjectState(state, freshState);
          });

          if (concurrentModificationDetected) {
            throw new Error(
              'Concurrent modification detected during history jump. Please retry the operation.',
            );
          }

          logger.debug('History jump completed', {
            targetIndex,
            newVersion: get().stateVersion,
          });
          return result;
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          logger.error('History jump failed', { targetIndex, error: errorMessage });

          set((state) => {
            state.error = errorMessage;
          });
          throw error;
        }
      }, `jumpToHistoryState:${targetIndex}`);
    },

    // Check if undo is available
    canUndo: async () => {
      try {
        return await invoke<boolean>('can_undo');
      } catch {
        return false;
      }
    },

    // Check if redo is available
    canRedo: async () => {
      try {
        return await invoke<boolean>('can_redo');
      } catch {
        return false;
      }
    },
  })),
);

configureProjectMutationGateway({
  executeCommand: (command) => useProjectStore.getState().executeCommand(command),
  executeCommandByType: (commandType, payload) =>
    useProjectStore.getState().executeBackendMutation(`executeCommand:${commandType}`, () =>
      invoke<CommandResult>('execute_command', {
        commandType,
        payload,
      }),
    ),
  executeBackendMutation: (operationName, mutation, options) =>
    useProjectStore.getState().executeBackendMutation(operationName, mutation, options),
});

// =============================================================================
// Proxy Event Listeners
// =============================================================================

/** Singleton array for tracking unlisten functions */
let proxyEventUnlisteners: UnlistenFn[] = [];

/** Flag to prevent re-entrant setup */
let isSettingUpListeners = false;

/**
 * Runtime detection for Tauri environment.
 * Returns false in web builds (Vite dev, Playwright E2E).
 */
function isTauriRuntime(): boolean {
  return (
    typeof (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !== 'undefined'
  );
}

/**
 * Setup event listeners for proxy generation events.
 *
 * Features:
 * - Re-entrant safe: prevents duplicate setup during async operations
 * - Error resilient: continues setup even if individual listeners fail
 * - Cleanup guaranteed: always cleans up before new setup
 *
 * Should be called once when the app initializes.
 * Events:
 * - asset:proxy-generating: Proxy generation started
 * - asset:proxy-ready: Proxy generation completed successfully
 * - asset:proxy-failed: Proxy generation failed
 */
export async function setupProxyEventListeners(): Promise<void> {
  // Prevent re-entrant setup
  if (isSettingUpListeners) {
    logger.warn('Proxy event listener setup already in progress');
    return;
  }

  isSettingUpListeners = true;

  try {
    // Clean up any existing listeners first
    await cleanupProxyEventListeners();

    // The Vite web build (used by Playwright E2E) does not have a Tauri backend.
    // In that environment, `listen()` will throw. This is not a fatal condition.
    if (!isTauriRuntime()) {
      logger.debug('Skipping proxy event listeners in non-Tauri environment');
      return;
    }

    const { updateAssetProxyStatus } = useProjectStore.getState();
    const newUnlisteners: UnlistenFn[] = [];

    // Listen for proxy generating event
    try {
      const unlistenGenerating = await listen<ProxyGeneratingEvent>(
        'asset:proxy-generating',
        (event) => {
          logger.info('Proxy generation started', { assetId: event.payload.assetId });
          if (event.payload.jobId !== 'manual-ffmpeg') {
            useProjectStore.setState((state) => {
              state.proxyJobIdsByAssetId[event.payload.assetId] = event.payload.jobId;
            });
          }
          updateAssetProxyStatus(event.payload.assetId, 'generating');
        },
      );
      newUnlisteners.push(unlistenGenerating);
    } catch (error) {
      logger.error('Failed to setup proxy-generating listener', { error });
    }

    // Listen for proxy ready event
    try {
      const unlistenReady = await listen<ProxyReadyEvent>('asset:proxy-ready', (event) => {
        logger.info('Proxy generation completed', {
          assetId: event.payload.assetId,
          proxyUrl: event.payload.proxyUrl,
        });
        useProjectStore.setState((state) => {
          delete state.proxyJobIdsByAssetId[event.payload.assetId];
        });
        updateAssetProxyStatus(event.payload.assetId, 'ready', event.payload.proxyUrl);
      });
      newUnlisteners.push(unlistenReady);
    } catch (error) {
      logger.error('Failed to setup proxy-ready listener', { error });
    }

    // Listen for proxy failed event
    try {
      const unlistenFailed = await listen<ProxyFailedEvent>('asset:proxy-failed', (event) => {
        logger.error('Proxy generation failed', {
          assetId: event.payload.assetId,
          error: event.payload.error,
        });
        useProjectStore.setState((state) => {
          delete state.proxyJobIdsByAssetId[event.payload.assetId];
        });
        updateAssetProxyStatus(event.payload.assetId, 'failed');
      });
      newUnlisteners.push(unlistenFailed);
    } catch (error) {
      logger.error('Failed to setup proxy-failed listener', { error });
    }

    // Only assign after all setup attempts complete
    proxyEventUnlisteners = newUnlisteners;

    logger.info('Proxy event listeners initialized', {
      listenerCount: newUnlisteners.length,
    });
  } finally {
    isSettingUpListeners = false;
  }
}

/**
 * Cleanup proxy event listeners.
 * Should be called when the app is closing.
 *
 * Safe to call multiple times - will not throw.
 */
export async function cleanupProxyEventListeners(): Promise<void> {
  const listenersToCleanup = proxyEventUnlisteners;
  proxyEventUnlisteners = [];

  for (const unlisten of listenersToCleanup) {
    try {
      unlisten();
    } catch (error) {
      logger.warn('Error during listener cleanup', { error });
    }
  }

  if (listenersToCleanup.length > 0) {
    logger.debug('Proxy event listeners cleaned up', {
      count: listenersToCleanup.length,
    });
  }
}
