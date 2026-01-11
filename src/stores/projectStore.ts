/**
 * Project Store
 *
 * Manages project state including assets, sequences, and project metadata.
 * Uses Zustand with Immer for immutable state updates.
 */

import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { enableMapSet } from 'immer';
import { invoke } from '@tauri-apps/api/core';
import type { Asset, Sequence, Command, CommandResult } from '@/types';

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
}

interface ProjectState {
  // State
  isLoaded: boolean;
  isLoading: boolean;
  isDirty: boolean;
  meta: ProjectMeta | null;
  assets: Map<string, Asset>;
  sequences: Map<string, Sequence>;
  activeSequenceId: string | null;
  selectedAssetId: string | null;
  error: string | null;

  // Actions
  loadProject: (path: string) => Promise<void>;
  createProject: (name: string, path: string) => Promise<void>;
  saveProject: () => Promise<void>;
  closeProject: () => void;

  // Asset actions
  importAsset: (uri?: string) => Promise<string>;
  removeAsset: (assetId: string) => Promise<void>;
  getAsset: (assetId: string) => Asset | undefined;
  selectAsset: (assetId: string | null) => void;

  // Sequence actions
  createSequence: (name: string, format: string) => Promise<string>;
  setActiveSequence: (sequenceId: string) => void;
  getActiveSequence: () => Sequence | undefined;

  // Command execution
  executeCommand: (command: Command) => Promise<CommandResult>;
  undo: () => Promise<void>;
  redo: () => Promise<CommandResult>;
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
    activeSequenceId: null,
    selectedAssetId: null,
    error: null,

    // Load existing project
    loadProject: async (path: string) => {
      set((state) => {
        state.isLoading = true;
        state.error = null;
      });

      try {
        const projectInfo = await invoke<ProjectMeta>('open_project', { path });

        set((state) => {
          state.isLoaded = true;
          state.isLoading = false;
          state.meta = projectInfo;
          state.isDirty = false;
          state.selectedAssetId = null;
        });

        // TODO: Load assets and sequences from backend
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
        const projectInfo = await invoke<ProjectMeta>('create_project', { name, path });

        set((state) => {
          state.isLoaded = true;
          state.isLoading = false;
          state.meta = projectInfo;
          state.assets = new Map();
          state.sequences = new Map();
          state.activeSequenceId = null;
          state.selectedAssetId = null;
          state.isDirty = false;
        });
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
    closeProject: () => {
      set((state) => {
        state.isLoaded = false;
        state.meta = null;
        state.assets = new Map();
        state.sequences = new Map();
        state.activeSequenceId = null;
        state.selectedAssetId = null;
        state.isDirty = false;
        state.error = null;
      });
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

        // TODO: Fetch full asset data and add to store
        set((state) => {
          state.isDirty = true;
          state.selectedAssetId = result.assetId;
        });

        return result.assetId;
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

    // Create sequence
    createSequence: async (name: string, format: string) => {
      try {
        const result = await invoke<{ id: string }>('create_sequence', { name, format });

        // TODO: Fetch full sequence data and add to store
        set((state) => {
          state.isDirty = true;
          if (!state.activeSequenceId) {
            state.activeSequenceId = result.id;
          }
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

    // Execute edit command
    executeCommand: async (command: Command) => {
      try {
        const result = await invoke<CommandResult>('execute_command', {
          commandType: command.type,
          payload: command.payload,
        });

        set((state) => {
          state.isDirty = true;
        });

        return result;
      } catch (error) {
        set((state) => {
          state.error = error instanceof Error ? error.message : String(error);
        });
        throw error;
      }
    },

    // Undo
    undo: async () => {
      try {
        await invoke('undo');
        set((state) => {
          state.isDirty = true;
        });
      } catch (error) {
        set((state) => {
          state.error = error instanceof Error ? error.message : String(error);
        });
        throw error;
      }
    },

    // Redo
    redo: async () => {
      try {
        const result = await invoke<CommandResult>('redo');
        set((state) => {
          state.isDirty = true;
        });
        return result;
      } catch (error) {
        set((state) => {
          state.error = error instanceof Error ? error.message : String(error);
        });
        throw error;
      }
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
  }))
);
