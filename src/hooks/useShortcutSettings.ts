/**
 * useShortcutSettings Hook
 *
 * Provides access to keyboard shortcut customization.
 * Wraps settingsStore with shortcut-specific convenience methods.
 */

import { useCallback } from 'react';
import { useSettingsStore } from '@/stores/settingsStore';
import {
  DEFAULT_SHORTCUTS,
  getShortcutForAction,
  getShortcutsByCategory,
  type CustomShortcuts,
  type ShortcutCategory,
  type ShortcutEntry,
} from '@/utils/shortcutActions';
import { compareSignatures } from '@/utils/shortcutUtils';

// =============================================================================
// Types
// =============================================================================

export interface UseShortcutSettingsReturn {
  /** Custom shortcut overrides from settings */
  customShortcuts: CustomShortcuts;

  /**
   * Gets the current shortcut for an action.
   * Returns custom shortcut if set, otherwise returns default.
   */
  getShortcut: (actionId: string) => string | undefined;

  /**
   * Sets a custom shortcut for an action.
   * Pass undefined or the default value to reset.
   */
  setShortcut: (actionId: string, shortcut: string) => void;

  /**
   * Resets a shortcut to its default value.
   */
  resetShortcut: (actionId: string) => void;

  /**
   * Resets all shortcuts to defaults.
   */
  resetAllShortcuts: () => void;

  /**
   * Checks if a shortcut has been customized.
   */
  isCustomized: (actionId: string) => boolean;

  /**
   * Checks if a shortcut conflicts with another action.
   * Returns the conflicting action ID or null.
   */
  hasConflict: (shortcut: string, excludeActionId?: string) => string | null;

  /**
   * Gets all shortcuts grouped by category.
   */
  getShortcutsByCategory: () => Record<ShortcutCategory, ShortcutEntry[]>;
}

// =============================================================================
// Hook
// =============================================================================

export function useShortcutSettings(): UseShortcutSettingsReturn {
  // Get custom shortcuts from settings store
  const customShortcuts = useSettingsStore(
    (state) => state.settings.shortcuts.customShortcuts ?? {}
  );

  // Get store actions
  const updateSettings = useSettingsStore((state) => state.updateSettings);

  /**
   * Sets a custom shortcut for an action.
   */
  const setShortcut = useCallback(
    (actionId: string, shortcut: string) => {
      updateSettings('shortcuts', {
        customShortcuts: {
          ...customShortcuts,
          [actionId]: shortcut,
        },
      });
    },
    [customShortcuts, updateSettings]
  );

  /**
   * Resets a shortcut to its default value.
   */
  const resetShortcut = useCallback(
    (actionId: string) => {
      const newCustom = { ...customShortcuts };
      delete newCustom[actionId];
      updateSettings('shortcuts', { customShortcuts: newCustom });
    },
    [customShortcuts, updateSettings]
  );

  /**
   * Resets all shortcuts to defaults.
   */
  const resetAllShortcuts = useCallback(() => {
    updateSettings('shortcuts', { customShortcuts: {} });
  }, [updateSettings]);

  /**
   * Gets the current shortcut for an action.
   */
  const getShortcut = useCallback(
    (actionId: string): string | undefined => {
      return getShortcutForAction(actionId, customShortcuts);
    },
    [customShortcuts]
  );

  /**
   * Checks if a shortcut has been customized.
   */
  const isCustomized = useCallback(
    (actionId: string): boolean => {
      return actionId in customShortcuts;
    },
    [customShortcuts]
  );

  /**
   * Checks if a shortcut conflicts with another action.
   */
  const hasConflict = useCallback(
    (shortcut: string, excludeActionId?: string): string | null => {
      // Build effective shortcuts map
      const effectiveShortcuts: Record<string, string> = {
        ...DEFAULT_SHORTCUTS,
        ...customShortcuts,
      };

      for (const [actionId, boundShortcut] of Object.entries(effectiveShortcuts)) {
        // Skip the action we're checking for
        if (actionId === excludeActionId) {
          continue;
        }
        // Check if shortcuts match
        if (compareSignatures(shortcut, boundShortcut)) {
          return actionId;
        }
      }

      return null;
    },
    [customShortcuts]
  );

  /**
   * Gets all shortcuts grouped by category.
   */
  const getShortcutsByCategoryMemo = useCallback(
    (): Record<ShortcutCategory, ShortcutEntry[]> => {
      return getShortcutsByCategory(customShortcuts);
    },
    [customShortcuts]
  );

  return {
    customShortcuts,
    getShortcut,
    setShortcut,
    resetShortcut,
    resetAllShortcuts,
    isCustomized,
    hasConflict,
    getShortcutsByCategory: getShortcutsByCategoryMemo,
  };
}

export default useShortcutSettings;
