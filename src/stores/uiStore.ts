/**
 * UI Store
 *
 * Manages global UI state including dialogs and modals.
 * Allows components to open/close dialogs from anywhere in the app.
 */

import { create } from 'zustand';

// =============================================================================
// Types
// =============================================================================

/** Settings dialog tab identifier */
export type SettingsTab = 'general' | 'appearance' | 'shortcuts' | 'ai';

/** UI Store State */
interface UIState {
  /** Whether settings dialog is open */
  isSettingsOpen: boolean;
  /** Which tab to show when settings opens */
  settingsActiveTab: SettingsTab;
}

/** UI Store Actions */
interface UIActions {
  /** Open settings dialog */
  openSettings: (tab?: SettingsTab) => void;
  /** Close settings dialog */
  closeSettings: () => void;
  /** Set the active settings tab */
  setSettingsTab: (tab: SettingsTab) => void;
}

// =============================================================================
// Store
// =============================================================================

export const useUIStore = create<UIState & UIActions>()((set) => ({
  // Initial state
  isSettingsOpen: false,
  settingsActiveTab: 'general',

  // Actions
  openSettings: (tab = 'general') => {
    set({ isSettingsOpen: true, settingsActiveTab: tab });
  },

  closeSettings: () => {
    set({ isSettingsOpen: false });
  },

  setSettingsTab: (tab) => {
    set({ settingsActiveTab: tab });
  },
}));

// =============================================================================
// Selectors
// =============================================================================

export const selectIsSettingsOpen = (state: UIState) => state.isSettingsOpen;
export const selectSettingsActiveTab = (state: UIState) => state.settingsActiveTab;
