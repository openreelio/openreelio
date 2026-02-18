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

/** Debounce delay in milliseconds for batching rapid settings updates */
const DEBOUNCE_DELAY_MS = 500;

/** Maximum number of pending resolvers to prevent memory leaks */
const MAX_PENDING_RESOLVERS = 100;

/** Maximum number of pending sections to batch */
const MAX_PENDING_SECTIONS = 20;

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
  hasCompletedSetup: boolean;
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

/** AI provider type */
export type ProviderType = 'openai' | 'anthropic' | 'gemini' | 'local';

/** Proposal review mode */
export type ProposalReviewMode = 'always' | 'smart' | 'auto_apply';

/** AI settings for provider configuration and behavior */
export interface AISettings {
  // Provider Configuration
  primaryProvider: ProviderType;
  primaryModel: string;
  visionProvider: ProviderType | null;
  visionModel: string | null;

  // API Keys
  openaiApiKey: string | null;
  anthropicApiKey: string | null;
  googleApiKey: string | null;
  ollamaUrl: string | null;

  // Generation Parameters
  temperature: number;
  maxTokens: number;
  frameExtractionRate: number;

  // Cost Controls
  monthlyBudgetCents: number | null;
  perRequestLimitCents: number;
  currentMonthUsageCents: number;
  currentUsageMonth: number | null;

  // Behavior
  autoAnalyzeOnImport: boolean;
  autoCaptionOnImport: boolean;
  proposalReviewMode: ProposalReviewMode;
  cacheDurationHours: number;

  // Privacy
  localOnlyMode: boolean;

  // Video Generation
  seedanceApiKey: string | null;
  videoGenProvider: 'seedance' | null;
  videoGenDefaultQuality: 'basic' | 'pro' | 'cinema';
  videoGenBudgetCents: number | null;
  videoGenPerRequestLimitCents: number;
}

/** Workspace settings for file discovery and management */
export interface WorkspaceSettings {
  /** Auto-scan workspace when a project is opened */
  autoScanOnOpen: boolean;
  /** Watch for file changes in the workspace */
  watchingEnabled: boolean;
  /** Auto-register workspace files when first used */
  autoRegisterOnUse: boolean;
  /** Maximum directory depth for scanning */
  scanDepthLimit: number;
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
  ai: AISettings;
  workspace: WorkspaceSettings;
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
  /** Flush any pending debounced updates immediately */
  flushPendingUpdates: () => Promise<void>;
  /** Clean up store resources (call before app exit) */
  destroy: () => void;
}

// =============================================================================
// Default Settings
// =============================================================================

const DEFAULT_SETTINGS: AppSettings = {
  version: 1,
  general: {
    language: 'en',
    showWelcomeOnStartup: true,
    hasCompletedSetup: false,
    recentProjectsLimit: 10,
    checkUpdatesOnStartup: false,
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
  ai: {
    primaryProvider: 'anthropic',
    primaryModel: 'claude-sonnet-4-5-20251015',
    visionProvider: null,
    visionModel: null,
    openaiApiKey: null,
    anthropicApiKey: null,
    googleApiKey: null,
    ollamaUrl: null,
    temperature: 0.3,
    maxTokens: 4096,
    frameExtractionRate: 1.0,
    monthlyBudgetCents: null,
    perRequestLimitCents: 50,
    currentMonthUsageCents: 0,
    currentUsageMonth: null,
    autoAnalyzeOnImport: false,
    autoCaptionOnImport: false,
    proposalReviewMode: 'always',
    cacheDurationHours: 24,
    localOnlyMode: false,
    seedanceApiKey: null,
    videoGenProvider: null,
    videoGenDefaultQuality: 'pro',
    videoGenBudgetCents: null,
    videoGenPerRequestLimitCents: 100,
  },
  workspace: {
    autoScanOnOpen: true,
    watchingEnabled: true,
    autoRegisterOnUse: true,
    scanDepthLimit: 10,
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function coerceAppSettings(value: unknown): AppSettings {
  if (!isRecord(value) || typeof value.version !== 'number') {
    return DEFAULT_SETTINGS;
  }

  // Always merge with defaults to tolerate backend/frontend schema drift.
  // The backend currently does not persist `workspace`, so this prevents
  // workspace-dependent features from crashing when settings are loaded.
  return {
    ...DEFAULT_SETTINGS,
    ...(value as Partial<AppSettings>),
    general: { ...DEFAULT_SETTINGS.general, ...(isRecord(value.general) ? value.general : {}) },
    editor: { ...DEFAULT_SETTINGS.editor, ...(isRecord(value.editor) ? value.editor : {}) },
    playback: { ...DEFAULT_SETTINGS.playback, ...(isRecord(value.playback) ? value.playback : {}) },
    export: { ...DEFAULT_SETTINGS.export, ...(isRecord(value.export) ? value.export : {}) },
    appearance: {
      ...DEFAULT_SETTINGS.appearance,
      ...(isRecord(value.appearance) ? value.appearance : {}),
    },
    shortcuts: {
      ...DEFAULT_SETTINGS.shortcuts,
      ...(isRecord(value.shortcuts) ? value.shortcuts : {}),
    },
    autoSave: {
      ...DEFAULT_SETTINGS.autoSave,
      ...(isRecord(value.autoSave) ? value.autoSave : {}),
    },
    performance: {
      ...DEFAULT_SETTINGS.performance,
      ...(isRecord(value.performance) ? value.performance : {}),
    },
    ai: { ...DEFAULT_SETTINGS.ai, ...(isRecord(value.ai) ? value.ai : {}) },
    workspace: {
      ...DEFAULT_SETTINGS.workspace,
      ...(isRecord(value.workspace) ? value.workspace : {}),
    },
  } as AppSettings;
}

// =============================================================================
// Store
// =============================================================================

export const useSettingsStore = create<SettingsState & SettingsActions>()(
  persist(
    immer((set, get) => {
      let saveTail: Promise<void> = Promise.resolve();
      let pendingCount = 0;

      // Debounce state for batching rapid updates
      let debounceTimer: ReturnType<typeof setTimeout> | null = null;
      let pendingPartials: Record<string, Record<string, unknown>> = {};
      let debounceResolvers: Array<{
        resolve: () => void;
        reject: (error: unknown) => void;
        timestamp: number;
      }> = [];

      // Track if store is being destroyed to prevent operations after cleanup
      let isDestroyed = false;

      /**
       * Clean up pending debounce state.
       * Safe to call multiple times.
       */
      const cleanupDebounce = (error?: Error): void => {
        if (debounceTimer !== null) {
          clearTimeout(debounceTimer);
          debounceTimer = null;
        }

        const resolversToClean = debounceResolvers;
        debounceResolvers = [];
        pendingPartials = {};

        // Reject all pending promises if error provided, otherwise resolve with void
        for (const resolver of resolversToClean) {
          if (error) {
            resolver.reject(error);
          } else {
            resolver.resolve();
          }
        }
      };

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

      /**
       * Flushes all pending debounced updates to the backend.
       * Merges all accumulated partial updates into a single backend call.
       *
       * Thread-safe: captures state before async operations.
       * Error-resilient: properly resolves/rejects all pending promises.
       */
      const flushDebouncedUpdates = async (): Promise<void> => {
        // Check if destroyed before proceeding
        if (isDestroyed) {
          logger.debug('Flush skipped - store is destroyed');
          return;
        }

        // Atomically capture and reset state
        const partials = pendingPartials;
        const resolvers = debounceResolvers;

        pendingPartials = {};
        debounceResolvers = [];
        debounceTimer = null;

        if (Object.keys(partials).length === 0) {
          // No partials but resolve any waiting promises
          for (const { resolve } of resolvers) {
            try {
              resolve();
            } catch {
              // Ignore resolve errors
            }
          }
          return;
        }

        await enqueueWrite(async () => {
          try {
            logger.info('Flushing debounced settings updates', {
              sections: Object.keys(partials),
              resolverCount: resolvers.length,
            });

            const raw = await invoke<unknown>('update_settings', { partial: partials });
            const updated = coerceAppSettings(raw);

            // Only update state if not destroyed
            if (!isDestroyed) {
              set((state) => {
                state.settings = updated;
                state.error = null;
              });
            }

            // Resolve all pending promises
            for (const { resolve } of resolvers) {
              try {
                resolve();
              } catch (e) {
                logger.warn('Error resolving settings update promise', { error: e });
              }
            }

            logger.info('Debounced settings update completed', {
              sections: Object.keys(partials),
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logger.error('Failed to flush debounced settings', {
              error: message,
              sections: Object.keys(partials),
            });

            // Only update state if not destroyed
            if (!isDestroyed) {
              set((state) => {
                state.error = message;
              });
            }

            // Reject all pending promises with the error
            for (const { reject } of resolvers) {
              try {
                reject(error);
              } catch (e) {
                logger.warn('Error rejecting settings update promise', { error: e });
              }
            }
            // Don't re-throw; error is propagated via rejected promises
          }
        });
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
          // Check if store is destroyed
          if (isDestroyed) {
            logger.warn('updateSettings called on destroyed store', { section });
            return;
          }

          // Update local state immediately for responsive UI (optimistic update)
          set((state) => {
            state.settings[section] = {
              ...state.settings[section],
              ...values,
            } as AppSettings[typeof section];
          });

          if (!isTauriRuntime()) {
            // Web build: keep the optimistic update only.
            return;
          }

          // Accumulate partial updates for debounced batch save
          const strippedValues = stripUndefined(values as Record<string, unknown>);

          // Check for pending sections limit to prevent memory issues
          if (
            Object.keys(pendingPartials).length >= MAX_PENDING_SECTIONS &&
            !(section in pendingPartials)
          ) {
            logger.warn('Too many pending sections, forcing flush', {
              pendingSections: Object.keys(pendingPartials).length,
            });
            // Force immediate flush
            if (debounceTimer !== null) {
              clearTimeout(debounceTimer);
              debounceTimer = null;
            }
            await flushDebouncedUpdates();
          }

          pendingPartials[section] = {
            ...(pendingPartials[section] || {}),
            ...strippedValues,
          };

          // Check for pending resolvers limit to prevent memory leaks
          if (debounceResolvers.length >= MAX_PENDING_RESOLVERS) {
            logger.warn('Too many pending resolvers, forcing flush', {
              pendingResolvers: debounceResolvers.length,
            });
            // Force immediate flush
            if (debounceTimer !== null) {
              clearTimeout(debounceTimer);
              debounceTimer = null;
            }
            await flushDebouncedUpdates();
          }

          // Create a promise for this update that will resolve when the batch is flushed
          return new Promise<void>((resolve, reject) => {
            debounceResolvers.push({
              resolve,
              reject,
              timestamp: Date.now(),
            });

            // Clear existing timer and set a new one
            if (debounceTimer !== null) {
              clearTimeout(debounceTimer);
            }

            debounceTimer = setTimeout(() => {
              flushDebouncedUpdates().catch((error) => {
                logger.error('Unexpected error in debounced flush', { error });
              });
            }, DEBOUNCE_DELAY_MS);
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

        flushPendingUpdates: async () => {
          if (debounceTimer !== null) {
            clearTimeout(debounceTimer);
            debounceTimer = null;
          }
          await flushDebouncedUpdates();
        },

        destroy: () => {
          logger.info('Destroying settings store');
          isDestroyed = true;
          cleanupDebounce(new Error('Store destroyed'));
        },

        /** Reset store internal state (for testing purposes) */
        _resetInternalState: () => {
          isDestroyed = false;
          pendingCount = 0;
          saveTail = Promise.resolve();
          // Clear debounce state without rejecting (just resolve pending promises)
          if (debounceTimer !== null) {
            clearTimeout(debounceTimer);
            debounceTimer = null;
          }
          // Resolve all pending promises to avoid unhandled rejections
          for (const { resolve } of debounceResolvers) {
            try {
              resolve();
            } catch {
              // Ignore
            }
          }
          debounceResolvers = [];
          pendingPartials = {};
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
      // Deep merge persisted state with defaults to prevent undefined sections
      merge: (persistedState, currentState) => {
        const persisted = persistedState as Partial<SettingsState> | undefined;
        const current = currentState as SettingsState & SettingsActions;

        // If no persisted state, use current (default) state
        if (!persisted || !persisted.settings) {
          return current;
        }

        // Deep merge: preserve all default settings and actions, override only persisted values
        return {
          ...current,
          settings: {
            ...current.settings,
            // Only merge appearance since that's what we persist
            appearance: persisted.settings.appearance
              ? { ...current.settings.appearance, ...persisted.settings.appearance }
              : current.settings.appearance,
          },
        };
      },
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

/** Select AI settings */
export const selectAISettings = (state: SettingsState) => state.settings.ai;

// =============================================================================
// Export default for convenience
// =============================================================================

export default useSettingsStore;
