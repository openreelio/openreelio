/**
 * Command Palette Store
 *
 * Manages the command palette UI state: open/close, search query,
 * selected index for keyboard navigation, and recent action history.
 */

import { create } from 'zustand';

// =============================================================================
// Types
// =============================================================================

/** Category for grouping palette actions */
export type ActionCategory =
  | 'Edit'
  | 'View'
  | 'Timeline'
  | 'Transport'
  | 'Effects'
  | 'Audio'
  | 'Export'
  | 'AI'
  | 'Settings'
  | 'Tools'
  | 'Source';

/** A single action that can be executed from the command palette */
export interface PaletteAction {
  /** Unique identifier */
  id: string;
  /** Display label */
  label: string;
  /** Category for grouping */
  category: ActionCategory;
  /** Keyboard shortcut display string (e.g., "Ctrl+Z") */
  shortcut?: string;
  /** Execute the action */
  execute: () => void;
  /** Whether this action is currently available */
  enabled?: boolean;
}

/** Command Palette Store State */
interface CommandPaletteState {
  /** Whether the palette is open */
  isOpen: boolean;
  /** Current search query */
  searchQuery: string;
  /** Index of the currently highlighted item */
  selectedIndex: number;
  /** Recently executed action IDs (most recent first, max 10) */
  recentActionIds: string[];
}

/** Command Palette Store Actions */
interface CommandPaletteActions {
  /** Open the command palette */
  open: () => void;
  /** Close the command palette and reset state */
  close: () => void;
  /** Toggle the command palette */
  toggle: () => void;
  /** Update the search query */
  setSearchQuery: (query: string) => void;
  /** Set the highlighted item index */
  setSelectedIndex: (index: number) => void;
  /** Record an action as recently used */
  recordRecentAction: (actionId: string) => void;
}

// =============================================================================
// Constants
// =============================================================================

const MAX_RECENT_ACTIONS = 10;

// =============================================================================
// Store
// =============================================================================

export const useCommandPaletteStore = create<CommandPaletteState & CommandPaletteActions>()(
  (set) => ({
    // Initial state
    isOpen: false,
    searchQuery: '',
    selectedIndex: 0,
    recentActionIds: [],

    // Actions
    open: () => {
      set({ isOpen: true, searchQuery: '', selectedIndex: 0 });
    },

    close: () => {
      set({ isOpen: false, searchQuery: '', selectedIndex: 0 });
    },

    toggle: () => {
      set((state) => {
        if (state.isOpen) {
          return { isOpen: false, searchQuery: '', selectedIndex: 0 };
        }
        return { isOpen: true, searchQuery: '', selectedIndex: 0 };
      });
    },

    setSearchQuery: (query) => {
      set({ searchQuery: query, selectedIndex: 0 });
    },

    setSelectedIndex: (index) => {
      set({ selectedIndex: index });
    },

    recordRecentAction: (actionId) => {
      set((state) => {
        const filtered = state.recentActionIds.filter((id) => id !== actionId);
        return {
          recentActionIds: [actionId, ...filtered].slice(0, MAX_RECENT_ACTIONS),
        };
      });
    },
  }),
);

// =============================================================================
// Selectors
// =============================================================================

export const selectIsCommandPaletteOpen = (state: CommandPaletteState): boolean => state.isOpen;
export const selectSearchQuery = (state: CommandPaletteState): string => state.searchQuery;
export const selectSelectedIndex = (state: CommandPaletteState): number => state.selectedIndex;
