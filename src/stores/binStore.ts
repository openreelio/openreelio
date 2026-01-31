/**
 * Bin Store
 *
 * Zustand store for managing bins/folders in the Project Explorer.
 * Handles bin CRUD operations, selection, and expansion state.
 */

import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { enableMapSet } from 'immer';
import type { Bin, BinId, BinColor } from '@/types';
import { canMoveBinTo, getBinDescendants, getDefaultBinColor } from '@/utils/binUtils';

// Enable Immer support for Map and Set
enableMapSet();

/**
 * Generates a unique ID for bins.
 * Uses timestamp + random for uniqueness.
 */
function generateBinId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 10);
  return `bin_${timestamp}${random}`;
}

// =============================================================================
// Types
// =============================================================================

export interface BinState {
  /** Map of bin ID to bin */
  bins: Map<BinId, Bin>;
  /** Currently selected bin ID (null = root) */
  selectedBinId: BinId | null;
  /** Bin currently being edited (inline rename) */
  editingBinId: BinId | null;
}

export interface BinActions {
  /** Sets bins from an array (e.g., from backend) */
  setBins: (bins: Bin[]) => void;
  /** Creates a new bin */
  createBin: (name: string, parentId: BinId | null, color?: BinColor) => Bin;
  /** Renames an existing bin */
  renameBin: (binId: BinId, newName: string) => void;
  /** Deletes a bin and its children */
  deleteBin: (binId: BinId) => void;
  /** Moves a bin to a new parent */
  moveBin: (binId: BinId, newParentId: BinId | null) => void;
  /** Selects a bin (null = root) */
  selectBin: (binId: BinId | null) => void;
  /** Toggles bin expansion */
  toggleExpand: (binId: BinId) => void;
  /** Sets bin color */
  setBinColor: (binId: BinId, color: BinColor) => void;
  /** Starts inline editing for a bin */
  startEditing: (binId: BinId) => void;
  /** Cancels inline editing */
  cancelEditing: () => void;
  /** Gets bins as array */
  getBinsArray: () => Bin[];
  /** Resets the store */
  reset: () => void;
}

export type BinStore = BinState & BinActions;

// =============================================================================
// Initial State
// =============================================================================

const initialState: BinState = {
  bins: new Map(),
  selectedBinId: null,
  editingBinId: null,
};

// =============================================================================
// Store
// =============================================================================

export const useBinStore = create<BinStore>()(
  immer((set, get) => ({
    ...initialState,

    setBins: (bins: Bin[]) => {
      set((state) => {
        state.bins = new Map(bins.map((bin) => [bin.id, bin]));
      });
    },

    createBin: (name: string, parentId: BinId | null, color?: BinColor): Bin => {
      const newBin: Bin = {
        id: generateBinId(),
        name,
        parentId,
        color: color ?? getDefaultBinColor(),
        createdAt: new Date().toISOString(),
        expanded: true,
      };

      set((state) => {
        state.bins.set(newBin.id, newBin);
      });

      return newBin;
    },

    renameBin: (binId: BinId, newName: string) => {
      set((state) => {
        const bin = state.bins.get(binId);
        if (bin) {
          bin.name = newName;
        }
        state.editingBinId = null;
      });
    },

    deleteBin: (binId: BinId) => {
      const { bins, selectedBinId } = get();

      // Get all descendants to delete
      const binsArray = Array.from(bins.values());
      const descendants = getBinDescendants(binId, binsArray);
      const toDelete = new Set([binId, ...descendants]);

      set((state) => {
        // Delete the bin and all descendants
        for (const id of toDelete) {
          state.bins.delete(id);
        }

        // Clear selection if deleted bin was selected
        if (selectedBinId && toDelete.has(selectedBinId)) {
          state.selectedBinId = null;
        }

        // Clear editing if deleted bin was being edited
        if (state.editingBinId && toDelete.has(state.editingBinId)) {
          state.editingBinId = null;
        }
      });
    },

    moveBin: (binId: BinId, newParentId: BinId | null) => {
      const { bins } = get();

      // Validate move
      if (!canMoveBinTo(binId, newParentId, bins)) {
        return;
      }

      set((state) => {
        const bin = state.bins.get(binId);
        if (bin) {
          bin.parentId = newParentId;
        }
      });
    },

    selectBin: (binId: BinId | null) => {
      set((state) => {
        state.selectedBinId = binId;
      });
    },

    toggleExpand: (binId: BinId) => {
      set((state) => {
        const bin = state.bins.get(binId);
        if (bin) {
          bin.expanded = !(bin.expanded ?? true);
        }
      });
    },

    setBinColor: (binId: BinId, color: BinColor) => {
      set((state) => {
        const bin = state.bins.get(binId);
        if (bin) {
          bin.color = color;
        }
      });
    },

    startEditing: (binId: BinId) => {
      set((state) => {
        state.editingBinId = binId;
      });
    },

    cancelEditing: () => {
      set((state) => {
        state.editingBinId = null;
      });
    },

    getBinsArray: () => {
      return Array.from(get().bins.values());
    },

    reset: () => {
      set(initialState);
    },
  }))
);

export default useBinStore;
