/**
 * Settings Store
 *
 * Manages application settings persistence with backend synchronization.
 * Uses Zustand with Immer for immutable state updates.
 * Settings are persisted to {app_data_dir}/settings.json via Tauri backend.
 */

import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { persist } from 'zustand/middleware';
import { invoke } from '@tauri-apps/api/core';
import { createLogger } from '@/services/logger';

const logger = createLogger('SettingsStore');

function isTauriRuntime(): boolean {
  // Unit tests mock `invoke()` and expect backend calls to be issued even
  // though the jsdom environment does not define `__TAURI_INTERNALS__`.
  // Playwright E2E runs the Vite web build (no Tauri backend), where calling
  // `invoke()` would throw.
  const isVitest =
    typeof process !== 'undefined' &&
    typeof process.env !== 'undefined' &&
    typeof process.env.VITEST !== 'undefined';

  if (isVitest) return true;

  return (
    typeof (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !== 'undefined'
  );
}

// =============================================================================
// Types
// =============================================================================

/** General application settings */
export interface GeneralSettings {
  language: string;
  showWelcomeOnStartup: boolean;
  recentProjectsLimit: number;
  checkUpdatesOnStartup: boolean;
  defaultProjectLocation: string | null;
}

/** Editor settings */
export interface EditorSettings {
  defaultTimelineZoom: number;
  snapToGrid: boolean;
  snapTolerance: number;
  showClipThumbnails: boolean;
  showAudioWaveforms: boolean;
  rippleEditDefault: boolean;
}

/** Playback settings */
export interface PlaybackSettings {
  defaultVolume: number;
  loopPlayback: boolean;
  previewQuality: 'auto' | 'full' | 'half' | 'quarter';
  audioScrubbing: boolean;
}

/** Export settings */
export interface ExportSettings {
  defaultFormat: 'mp4' | 'webm' | 'mov' | 'gif';
  defaultVideoCodec: 'h264' | 'h265' | 'vp9' | 'prores';
  defaultAudioCodec: 'aac' | 'mp3' | 'opus';
  defaultExportLocation: string | null;
  openFolderAfterExport: boolean;
}

/** Appearance settings */
export interface AppearanceSettings {
  theme: 'light' | 'dark' | 'system';
  accentColor: string;
  uiScale: number;
  showStatusBar: boolean;
  compactMode: boolean;
}

/** Keyboard shortcut settings */
export interface ShortcutSettings {
  customShortcuts: Record<string, string>;
}

/** Auto-save settings */
export interface AutoSaveSettings {
  enabled: boolean;
  intervalSeconds: number;
  backupCount: number;
}

/** Performance settings */
export interface PerformanceSettings {
  hardwareAcceleration: boolean;
  proxyGeneration: boolean;
  proxyResolution: '720p' | '480p' | '360p';
  maxConcurrentJobs: number;
  memoryLimitMb: number;
  cacheSizeMb: number;
}

/** Complete application settings */
export interface AppSettings {
  version: number;
  general: GeneralSettings;
  editor: EditorSettings;
  playback: PlaybackSettings;
  export: ExportSettings;
  appearance: AppearanceSettings;
  shortcuts: ShortcutSettings;
  autoSave: AutoSaveSettings;
  performance: PerformanceSettings;
}

type SettingsSectionKey = Exclude<keyof AppSettings, 'version'>;

/** Settings store state */
interface SettingsState {
  /** Current settings */
  settings: AppSettings;
  /** Whether settings have been loaded from backend */
  isLoaded: boolean;
  /** Whether settings are currently being saved */
  isSaving: boolean;
  /** Error message if any */
  error: string | null;
}

/** Settings store actions */
interface SettingsActions {
  /** Load settings from backend */
  loadSettings: () => Promise<void>;
  /** Save all settings to backend */
  saveSettings: () => Promise<void>;
  /** Update a partial section of settings */
  updateSettings: <K extends SettingsSectionKey>(
    section: K,
    values: Partial<AppSettings[K]>,
  ) => Promise<void>;
  /** Reset settings to defaults */
  resetSettings: () => Promise<void>;
  /** Update local state without saving (for form inputs) */
  setLocalSettings: <K extends SettingsSectionKey>(
    section: K,
    values: Partial<AppSettings[K]>,
  ) => void;
  /** Clear error */
  clearError: () => void;
}

// =============================================================================
// Default Settings
// =============================================================================

const DEFAULT_SETTINGS: AppSettings = {
  version: 1,
  general: {
    language: 'en',
    showWelcomeOnStartup: true,
    recentProjectsLimit: 10,
    checkUpdatesOnStartup: true,
    defaultProjectLocation: null,
  },
  editor: {
    defaultTimelineZoom: 1.0,
    snapToGrid: true,
    snapTolerance: 10,
    showClipThumbnails: true,
    showAudioWaveforms: true,
    rippleEditDefault: false,
  },
  playback: {
    defaultVolume: 0.8,
    loopPlayback: false,
    previewQuality: 'auto',
    audioScrubbing: true,
  },
  export: {
    defaultFormat: 'mp4',
    defaultVideoCodec: 'h264',
    defaultAudioCodec: 'aac',
    defaultExportLocation: null,
    openFolderAfterExport: true,
  },
  appearance: {
    theme: 'dark',
    accentColor: '#3b82f6',
    uiScale: 1.0,
    showStatusBar: true,
    compactMode: false,
  },
  shortcuts: {
    customShortcuts: {},
  },
  autoSave: {
    enabled: true,
    intervalSeconds: 300,
    backupCount: 3,
  },
  performance: {
    hardwareAcceleration: true,
    proxyGeneration: true,
    proxyResolution: '720p',
    maxConcurrentJobs: 4,
    memoryLimitMb: 0,
    cacheSizeMb: 1024,
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isAppSettings(value: unknown): value is AppSettings {
  if (!isRecord(value)) return false;
  if (typeof value.version !== 'number') return false;
  const requiredSections = [
    'general',
    'editor',
    'playback',
    'export',
    'appearance',
    'shortcuts',
    'autoSave',
    'performance',
  ];
  return requiredSections.every((key) => key in value);
}

function coerceAppSettings(value: unknown): AppSettings {
  if (isAppSettings(value)) return value;
  return DEFAULT_SETTINGS;
}

// =============================================================================
// Store
// =============================================================================

export const useSettingsStore = create<SettingsState & SettingsActions>()(
  persist(
    immer((set, get) => {
      let saveTail: Promise<void> = Promise.resolve();
      let pendingCount = 0;

      const enqueueWrite = (op: () => Promise<void>): Promise<void> => {
        pendingCount += 1;
        set((state) => {
          state.isSaving = true;
        });

        const run = async () => {
          await op();
        };

        const result = saveTail.then(run, run);

        // Keep the tail always resolved so future writes still run after failures.
        saveTail = result.then(
          () => undefined,
          () => undefined,
        );

        return result.finally(() => {
          pendingCount -= 1;
          if (pendingCount === 0) {
            set((state) => {
              state.isSaving = false;
            });
          }
        });
      };

      const stripUndefined = (input: Record<string, unknown>): Record<string, unknown> => {
        const out: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(input)) {
          if (value !== undefined) out[key] = value;
        }
        return out;
      };

      return {
        // Initial state
        settings: DEFAULT_SETTINGS,
        isLoaded: false,
        isSaving: false,
        error: null,

        // Actions
        loadSettings: async () => {
          try {
            // Playwright E2E runs the Vite web build without a Tauri backend.
            // In that environment, `invoke()` will throw; treat settings as in-memory defaults.
            if (!isTauriRuntime()) {
              set((state) => {
                state.settings = DEFAULT_SETTINGS;
                state.isLoaded = true;
                state.error = null;
              });
              return;
            }

            logger.info('Loading settings from backend...');
            const raw = await invoke<unknown>('get_settings');
            const settings = coerceAppSettings(raw);
            set((state) => {
              state.settings = settings;
              state.isLoaded = true;
              state.error = null;
            });
            logger.info('Settings loaded successfully');
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logger.error('Failed to load settings', { error: message });
            set((state) => {
              state.error = message;
              state.isLoaded = true; // Use defaults on error
            });
          }
        },

        saveSettings: async () => {
          if (!isTauriRuntime()) {
            // Web build: nothing to persist.
            set((state) => {
              state.error = null;
            });
            return;
          }

          return enqueueWrite(async () => {
            const { settings } = get();
            try {
              logger.info('Saving settings to backend...');
              await invoke('set_settings', { settings });
              set((state) => {
                state.error = null;
              });
              logger.info('Settings saved successfully');
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              logger.error('Failed to save settings', { error: message });
              set((state) => {
                state.error = message;
              });
              throw error;
            }
          });
        },

        updateSettings: async (section, values) => {
          // Save previous value for rollback on failure
          const previousSectionValue = { ...get().settings[section] };

          // Update local state immediately for responsive UI (optimistic update)
          set((state) => {
            state.settings[section] = {
              ...state.settings[section],
              ...values,
            } as AppSettings[typeof section];
          });

          // Persist via backend partial update (serialized + validated in Rust).
          const partial = { [section]: stripUndefined(values as Record<string, unknown>) };

          if (!isTauriRuntime()) {
            // Web build: keep the optimistic update only.
            return;
          }

          await enqueueWrite(async () => {
            try {
              const raw = await invoke<unknown>('update_settings', { partial });
              const updated = coerceAppSettings(raw);
              set((state) => {
                state.settings = updated;
                state.error = null;
              });
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              logger.error('Failed to update settings', { error: message });
              // Rollback to previous value on failure
              set((state) => {
                state.settings[section] = previousSectionValue as AppSettings[typeof section];
                state.error = message;
              });
              throw error;
            }
          });
        },

        resetSettings: async () => {
          if (!isTauriRuntime()) {
            set((state) => {
              state.settings = DEFAULT_SETTINGS;
              state.error = null;
            });
            return;
          }

          await enqueueWrite(async () => {
            try {
              logger.info('Resetting settings to defaults...');
              const raw = await invoke<unknown>('reset_settings');
              const settings = coerceAppSettings(raw);
              set((state) => {
                state.settings = settings;
                state.error = null;
              });
              logger.info('Settings reset successfully');
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              logger.error('Failed to reset settings', { error: message });
              set((state) => {
                state.error = message;
              });
              throw error;
            }
          });
        },

        setLocalSettings: (section, values) => {
          set((state) => {
            state.settings[section] = {
              ...state.settings[section],
              ...values,
            } as AppSettings[typeof section];
          });
        },

        clearError: () => {
          set((state) => {
            state.error = null;
          });
        },
      };
    }),
    {
      name: 'openreelio-settings',
      // Only persist a subset for quick UI restoration before backend load
      partialize: (state) => ({
        settings: {
          appearance: state.settings.appearance,
        },
      }),
    },
  ),
);

// =============================================================================
// Selectors
// =============================================================================

/** Select general settings */
export const selectGeneralSettings = (state: SettingsState) => state.settings.general;

/** Select editor settings */
export const selectEditorSettings = (state: SettingsState) => state.settings.editor;

/** Select playback settings */
export const selectPlaybackSettings = (state: SettingsState) => state.settings.playback;

/** Select export settings */
export const selectExportSettings = (state: SettingsState) => state.settings.export;

/** Select appearance settings */
export const selectAppearanceSettings = (state: SettingsState) => state.settings.appearance;

/** Select shortcut settings */
export const selectShortcutSettings = (state: SettingsState) => state.settings.shortcuts;

/** Select auto-save settings */
export const selectAutoSaveSettings = (state: SettingsState) => state.settings.autoSave;

/** Select performance settings */
export const selectPerformanceSettings = (state: SettingsState) => state.settings.performance;

// =============================================================================
// Export default for convenience
// =============================================================================

export default useSettingsStore;
