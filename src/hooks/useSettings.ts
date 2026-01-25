/**
 * useSettings Hook
 *
 * Provides convenient access to settings with automatic loading on mount.
 * Designed for use in components that need to read or modify settings.
 */

import { useCallback, useEffect } from 'react';
import {
  useSettingsStore,
  selectGeneralSettings,
  selectEditorSettings,
  selectPlaybackSettings,
  selectExportSettings,
  selectAppearanceSettings,
  selectShortcutSettings,
  selectAutoSaveSettings,
  selectPerformanceSettings,
  selectAISettings,
  type AppSettings,
  type GeneralSettings,
  type EditorSettings,
  type PlaybackSettings,
  type ExportSettings,
  type AppearanceSettings,
  type ShortcutSettings,
  type AutoSaveSettings,
  type PerformanceSettings,
  type AISettings,
} from '@/stores/settingsStore';

export interface UseSettingsOptions {
  /** Auto-load settings on mount (default: true) */
  autoLoad?: boolean;
}

export interface UseSettingsReturn {
  // State
  settings: AppSettings;
  isLoaded: boolean;
  isSaving: boolean;
  error: string | null;

  // Section selectors
  general: GeneralSettings;
  editor: EditorSettings;
  playback: PlaybackSettings;
  export: ExportSettings;
  appearance: AppearanceSettings;
  shortcuts: ShortcutSettings;
  autoSave: AutoSaveSettings;
  performance: PerformanceSettings;
  ai: AISettings;

  // Actions
  loadSettings: () => Promise<void>;
  saveSettings: () => Promise<void>;
  updateGeneral: (values: Partial<GeneralSettings>) => Promise<void>;
  updateEditor: (values: Partial<EditorSettings>) => Promise<void>;
  updatePlayback: (values: Partial<PlaybackSettings>) => Promise<void>;
  updateExport: (values: Partial<ExportSettings>) => Promise<void>;
  updateAppearance: (values: Partial<AppearanceSettings>) => Promise<void>;
  updateShortcuts: (values: Partial<ShortcutSettings>) => Promise<void>;
  updateAutoSave: (values: Partial<AutoSaveSettings>) => Promise<void>;
  updatePerformance: (values: Partial<PerformanceSettings>) => Promise<void>;
  updateAI: (values: Partial<AISettings>) => Promise<void>;
  resetSettings: () => Promise<void>;
  clearError: () => void;
}

/**
 * Hook for accessing and modifying application settings
 */
export function useSettings(options: UseSettingsOptions = {}): UseSettingsReturn {
  const { autoLoad = true } = options;

  // Store state
  const settings = useSettingsStore((state) => state.settings);
  const isLoaded = useSettingsStore((state) => state.isLoaded);
  const isSaving = useSettingsStore((state) => state.isSaving);
  const error = useSettingsStore((state) => state.error);

  // Section selectors
  const general = useSettingsStore(selectGeneralSettings);
  const editor = useSettingsStore(selectEditorSettings);
  const playback = useSettingsStore(selectPlaybackSettings);
  const exportSettings = useSettingsStore(selectExportSettings);
  const appearance = useSettingsStore(selectAppearanceSettings);
  const shortcuts = useSettingsStore(selectShortcutSettings);
  const autoSaveSettings = useSettingsStore(selectAutoSaveSettings);
  const performance = useSettingsStore(selectPerformanceSettings);
  const ai = useSettingsStore(selectAISettings);

  // Actions
  const loadSettings = useSettingsStore((state) => state.loadSettings);
  const saveSettings = useSettingsStore((state) => state.saveSettings);
  const updateSettings = useSettingsStore((state) => state.updateSettings);
  const resetSettings = useSettingsStore((state) => state.resetSettings);
  const clearError = useSettingsStore((state) => state.clearError);

  // Section update helpers
  const updateGeneral = useCallback(
    (values: Partial<GeneralSettings>) => updateSettings('general', values),
    [updateSettings]
  );

  const updateEditor = useCallback(
    (values: Partial<EditorSettings>) => updateSettings('editor', values),
    [updateSettings]
  );

  const updatePlayback = useCallback(
    (values: Partial<PlaybackSettings>) => updateSettings('playback', values),
    [updateSettings]
  );

  const updateExport = useCallback(
    (values: Partial<ExportSettings>) => updateSettings('export', values),
    [updateSettings]
  );

  const updateAppearance = useCallback(
    (values: Partial<AppearanceSettings>) => updateSettings('appearance', values),
    [updateSettings]
  );

  const updateShortcuts = useCallback(
    (values: Partial<ShortcutSettings>) => updateSettings('shortcuts', values),
    [updateSettings]
  );

  const updateAutoSave = useCallback(
    (values: Partial<AutoSaveSettings>) => updateSettings('autoSave', values),
    [updateSettings]
  );

  const updatePerformance = useCallback(
    (values: Partial<PerformanceSettings>) => updateSettings('performance', values),
    [updateSettings]
  );

  const updateAI = useCallback(
    (values: Partial<AISettings>) => updateSettings('ai', values),
    [updateSettings]
  );

  // Auto-load on mount
  useEffect(() => {
    if (autoLoad && !isLoaded) {
      loadSettings();
    }
  }, [autoLoad, isLoaded, loadSettings]);

  return {
    // State
    settings,
    isLoaded,
    isSaving,
    error,

    // Section selectors
    general,
    editor,
    playback,
    export: exportSettings,
    appearance,
    shortcuts,
    autoSave: autoSaveSettings,
    performance,
    ai,

    // Actions
    loadSettings,
    saveSettings,
    updateGeneral,
    updateEditor,
    updatePlayback,
    updateExport,
    updateAppearance,
    updateShortcuts,
    updateAutoSave,
    updatePerformance,
    updateAI,
    resetSettings,
    clearError,
  };
}

export default useSettings;
