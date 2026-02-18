/**
 * Settings Store Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';

// Mock Tauri invoke
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

// Mock logger
vi.mock('@/services/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { invoke } from '@tauri-apps/api/core';
import { useSettingsStore, type AppSettings } from './settingsStore';

const mockInvoke = vi.mocked(invoke);

/** Debounce delay must match the constant in settingsStore.ts */
const DEBOUNCE_DELAY_MS = 500;

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
    localOnlyMode: false, seedanceApiKey: null, videoGenProvider: null, videoGenDefaultQuality: 'pro', videoGenBudgetCents: null, videoGenPerRequestLimitCents: 100,
  },
  workspace: {
    autoScanOnOpen: true,
    watchingEnabled: true,
    autoRegisterOnUse: true,
    scanDepthLimit: 10,
  },
};

describe('settingsStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset store state
    useSettingsStore.setState({
      settings: DEFAULT_SETTINGS,
      isLoaded: false,
      isSaving: false,
      error: null,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('loadSettings', () => {
    it('should load settings from backend', async () => {
      const mockSettings: AppSettings = {
        ...DEFAULT_SETTINGS,
        general: { ...DEFAULT_SETTINGS.general, language: 'ko' },
      };
      mockInvoke.mockResolvedValueOnce(mockSettings);

      const { result } = renderHook(() => useSettingsStore());

      await act(async () => {
        await result.current.loadSettings();
      });

      expect(mockInvoke).toHaveBeenCalledWith('get_settings');
      expect(result.current.settings.general.language).toBe('ko');
      expect(result.current.isLoaded).toBe(true);
      expect(result.current.error).toBeNull();
    });

    it('should handle load error gracefully', async () => {
      mockInvoke.mockRejectedValueOnce(new Error('Backend error'));

      const { result } = renderHook(() => useSettingsStore());

      await act(async () => {
        await result.current.loadSettings();
      });

      expect(result.current.isLoaded).toBe(true);
      expect(result.current.error).toBe('Backend error');
      // Should keep default settings on error
      expect(result.current.settings.general.language).toBe('en');
    });
  });

  describe('saveSettings', () => {
    it('should save settings to backend', async () => {
      mockInvoke.mockResolvedValueOnce(undefined);

      const { result } = renderHook(() => useSettingsStore());

      await act(async () => {
        await result.current.saveSettings();
      });

      expect(mockInvoke).toHaveBeenCalledWith('set_settings', {
        settings: expect.objectContaining({
          version: 1,
          general: expect.any(Object),
        }),
      });
      expect(result.current.isSaving).toBe(false);
      expect(result.current.error).toBeNull();
    });

    it('should handle save error', async () => {
      mockInvoke.mockRejectedValueOnce(new Error('Save failed'));

      const { result } = renderHook(() => useSettingsStore());

      await act(async () => {
        try {
          await result.current.saveSettings();
        } catch {
          // Expected to throw
        }
      });

      expect(result.current.isSaving).toBe(false);
      expect(result.current.error).toBe('Save failed');
    });

    it('should prevent concurrent saves', async () => {
      mockInvoke.mockImplementation(() => new Promise((resolve) => setTimeout(resolve, 100)));

      const { result } = renderHook(() => useSettingsStore());

      // Start first save
      act(() => {
        result.current.saveSettings();
      });

      // Try second save immediately
      await act(async () => {
        await result.current.saveSettings();
      });

      // Saves are queued; both requests should be persisted.
      expect(mockInvoke).toHaveBeenCalledTimes(2);
    });
  });

  describe('updateSettings', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should update local state immediately for responsive UI', async () => {
      const { result } = renderHook(() => useSettingsStore());

      // Update triggers immediate local change
      act(() => {
        result.current.updateSettings('general', { language: 'ja' });
      });

      // Local state updates immediately (before debounce)
      expect(result.current.settings.general.language).toBe('ja');
      // Backend call is not yet made (debouncing)
      expect(mockInvoke).not.toHaveBeenCalled();
    });

    it('should debounce rapid updates and batch them', async () => {
      const updated: AppSettings = {
        ...DEFAULT_SETTINGS,
        general: {
          ...DEFAULT_SETTINGS.general,
          language: 'ja',
          showWelcomeOnStartup: false,
        },
      };
      mockInvoke.mockResolvedValueOnce(updated);

      const { result } = renderHook(() => useSettingsStore());

      // Make multiple rapid updates
      act(() => {
        result.current.updateSettings('general', { language: 'ko' });
      });
      act(() => {
        result.current.updateSettings('general', { language: 'ja' });
      });
      act(() => {
        result.current.updateSettings('general', { showWelcomeOnStartup: false });
      });

      // Before debounce fires, no backend calls
      expect(mockInvoke).not.toHaveBeenCalled();

      // Fast-forward past debounce delay
      await act(async () => {
        vi.advanceTimersByTime(DEBOUNCE_DELAY_MS);
        await vi.runAllTimersAsync();
      });

      // Should be a single batched call with all changes
      expect(mockInvoke).toHaveBeenCalledTimes(1);
      expect(mockInvoke).toHaveBeenCalledWith('update_settings', {
        partial: {
          general: {
            language: 'ja', // Last value wins
            showWelcomeOnStartup: false,
          },
        },
      });
    });

    it('should batch updates across different sections', async () => {
      const updated: AppSettings = {
        ...DEFAULT_SETTINGS,
        general: { ...DEFAULT_SETTINGS.general, language: 'ja' },
        appearance: { ...DEFAULT_SETTINGS.appearance, theme: 'light' },
      };
      mockInvoke.mockResolvedValueOnce(updated);

      const { result } = renderHook(() => useSettingsStore());

      // Update different sections
      act(() => {
        result.current.updateSettings('general', { language: 'ja' });
      });
      act(() => {
        result.current.updateSettings('appearance', { theme: 'light' });
      });

      // Fast-forward past debounce delay
      await act(async () => {
        vi.advanceTimersByTime(DEBOUNCE_DELAY_MS);
        await vi.runAllTimersAsync();
      });

      // Should batch all sections into one call
      expect(mockInvoke).toHaveBeenCalledTimes(1);
      expect(mockInvoke).toHaveBeenCalledWith('update_settings', {
        partial: {
          general: { language: 'ja' },
          appearance: { theme: 'light' },
        },
      });
    });

    it('should preserve other fields in section', async () => {
      const updated: AppSettings = {
        ...DEFAULT_SETTINGS,
        general: { ...DEFAULT_SETTINGS.general, showWelcomeOnStartup: false },
      };
      mockInvoke.mockResolvedValueOnce(updated);

      const { result } = renderHook(() => useSettingsStore());

      act(() => {
        result.current.updateSettings('general', { showWelcomeOnStartup: false });
      });

      // Local state should reflect the change
      expect(result.current.settings.general.language).toBe('en');
      expect(result.current.settings.general.showWelcomeOnStartup).toBe(false);

      // Fast-forward to trigger backend save
      await act(async () => {
        vi.advanceTimersByTime(DEBOUNCE_DELAY_MS);
        await vi.runAllTimersAsync();
      });

      expect(result.current.settings.general.showWelcomeOnStartup).toBe(false);
    });

    it('should handle backend error and set error state', async () => {
      mockInvoke.mockRejectedValueOnce(new Error('Update failed'));

      const { result } = renderHook(() => useSettingsStore());

      // Verify initial state
      expect(result.current.settings.general.language).toBe('en');

      // Start update (optimistic) - capture the promise and add immediate catch
      let caughtError: unknown = null;
      act(() => {
        const promise = result.current.updateSettings('general', { language: 'ko' });
        // Immediately attach catch to prevent unhandled rejection
        promise.catch((e) => {
          caughtError = e;
        });
      });

      // Local state updates optimistically
      expect(result.current.settings.general.language).toBe('ko');

      // Advance timers to trigger the debounced save
      act(() => {
        vi.advanceTimersByTime(DEBOUNCE_DELAY_MS + 100);
      });

      // Run all pending promises and timers
      await act(async () => {
        await vi.runAllTimersAsync();
      });

      // Wait a microtask for the rejection to be handled
      await act(async () => {
        await Promise.resolve();
      });

      // Verify error was caught
      expect(caughtError).toBeInstanceOf(Error);
      expect((caughtError as Error).message).toBe('Update failed');

      // Error is captured in store state
      expect(result.current.error).toBe('Update failed');
    });
  });

  describe('resetSettings', () => {
    it('should reset settings to defaults', async () => {
      mockInvoke.mockResolvedValueOnce(DEFAULT_SETTINGS);

      const { result } = renderHook(() => useSettingsStore());

      // Modify settings first
      act(() => {
        result.current.setLocalSettings('general', { language: 'ko' });
      });
      expect(result.current.settings.general.language).toBe('ko');

      // Reset
      await act(async () => {
        await result.current.resetSettings();
      });

      expect(mockInvoke).toHaveBeenCalledWith('reset_settings');
      expect(result.current.settings.general.language).toBe('en');
    });
  });

  describe('setLocalSettings', () => {
    it('should update local state without saving', () => {
      const { result } = renderHook(() => useSettingsStore());

      act(() => {
        result.current.setLocalSettings('appearance', { theme: 'light' });
      });

      expect(result.current.settings.appearance.theme).toBe('light');
      expect(mockInvoke).not.toHaveBeenCalled();
    });
  });

  describe('clearError', () => {
    it('should clear error state', () => {
      useSettingsStore.setState({ error: 'Some error' });

      const { result } = renderHook(() => useSettingsStore());
      expect(result.current.error).toBe('Some error');

      act(() => {
        result.current.clearError();
      });

      expect(result.current.error).toBeNull();
    });
  });

  describe('flushPendingUpdates', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should immediately flush pending debounced updates', async () => {
      mockInvoke.mockResolvedValue({
        ...DEFAULT_SETTINGS,
        general: { ...DEFAULT_SETTINGS.general, language: 'ja' },
      });

      const { result } = renderHook(() => useSettingsStore());

      // Start an update (will be debounced)
      act(() => {
        result.current.updateSettings('general', { language: 'ja' });
      });

      // Before flush, no backend call
      expect(mockInvoke).not.toHaveBeenCalled();

      // Force flush
      await act(async () => {
        await result.current.flushPendingUpdates();
      });

      // Should have made the backend call immediately
      expect(mockInvoke).toHaveBeenCalledWith('update_settings', {
        partial: { general: { language: 'ja' } },
      });
    });
  });

});

// =============================================================================
// Destructive Test Scenarios
// =============================================================================

// =============================================================================
// Persist Middleware Merge Tests
// =============================================================================

describe('settingsStore - Persist Merge Behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSettingsStore.setState({
      settings: DEFAULT_SETTINGS,
      isLoaded: false,
      isSaving: false,
      error: null,
    });
  });

  it('should have all settings sections defined after initialization', () => {
    const { result } = renderHook(() => useSettingsStore());

    // All settings sections should be defined
    expect(result.current.settings.general).toBeDefined();
    expect(result.current.settings.editor).toBeDefined();
    expect(result.current.settings.playback).toBeDefined();
    expect(result.current.settings.export).toBeDefined();
    expect(result.current.settings.appearance).toBeDefined();
    expect(result.current.settings.shortcuts).toBeDefined();
    expect(result.current.settings.autoSave).toBeDefined();
    expect(result.current.settings.performance).toBeDefined();
  });

  it('should have checkUpdatesOnStartup defined in general settings', () => {
    const { result } = renderHook(() => useSettingsStore());

    expect(result.current.settings.general.checkUpdatesOnStartup).toBeDefined();
    expect(typeof result.current.settings.general.checkUpdatesOnStartup).toBe('boolean');
  });

  it('should preserve defaults when state is partially hydrated', () => {
    // After merge, general should still exist with defaults
    // This verifies that the merge function in persist config works correctly
    const { result } = renderHook(() => useSettingsStore());

    // Verify all sections exist with their default values
    expect(result.current.settings.general).toBeDefined();
    expect(result.current.settings.general.checkUpdatesOnStartup).toBe(false);
    expect(result.current.settings.general.language).toBe('en');

    // Verify critical fields that caused the original bug are present
    expect(typeof result.current.settings.general.checkUpdatesOnStartup).toBe('boolean');
    expect(result.current.settings.general.showWelcomeOnStartup).toBe(true);
  });
});

describe('settingsStore - Destructive Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset internal state and store state
    const store = useSettingsStore.getState();
    if ('_resetInternalState' in store) {
      (store as { _resetInternalState: () => void })._resetInternalState();
    }
    useSettingsStore.setState({
      settings: DEFAULT_SETTINGS,
      isLoaded: false,
      isSaving: false,
      error: null,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    // Reset internal state after each test
    const store = useSettingsStore.getState();
    if ('_resetInternalState' in store) {
      (store as { _resetInternalState: () => void })._resetInternalState();
    }
  });

  describe('Optimistic Updates', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should apply optimistic updates immediately', async () => {
      mockInvoke.mockResolvedValue(DEFAULT_SETTINGS);

      const { result } = renderHook(() => useSettingsStore());

      // Update triggers optimistic local change
      act(() => {
        result.current.updateSettings('general', { language: 'ko' });
      });

      // Local state should update immediately before backend call
      expect(result.current.settings.general.language).toBe('ko');
      expect(mockInvoke).not.toHaveBeenCalled();

      // Fast-forward past debounce
      await act(async () => {
        vi.advanceTimersByTime(DEBOUNCE_DELAY_MS + 100);
        await vi.runAllTimersAsync();
      });

      // Backend call should have been made
      expect(mockInvoke).toHaveBeenCalled();
    });

    it('should preserve optimistic updates across rapid changes', async () => {
      mockInvoke.mockResolvedValue({
        ...DEFAULT_SETTINGS,
        general: { ...DEFAULT_SETTINGS.general, language: 'de' },
      });

      const { result } = renderHook(() => useSettingsStore());

      // Rapid updates
      act(() => {
        result.current.updateSettings('general', { language: 'ko' });
      });
      expect(result.current.settings.general.language).toBe('ko');

      act(() => {
        result.current.updateSettings('general', { language: 'ja' });
      });
      expect(result.current.settings.general.language).toBe('ja');

      act(() => {
        result.current.updateSettings('general', { language: 'de' });
      });
      expect(result.current.settings.general.language).toBe('de');

      // Fast-forward past debounce
      await act(async () => {
        vi.advanceTimersByTime(DEBOUNCE_DELAY_MS + 100);
        await vi.runAllTimersAsync();
      });

      // Should batch into single call with final value
      expect(mockInvoke).toHaveBeenCalledTimes(1);
    });
  });

  describe('Multi-Section Batching', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should batch updates across different sections', async () => {
      const finalSettings = {
        ...DEFAULT_SETTINGS,
        general: { ...DEFAULT_SETTINGS.general, language: 'ja' },
        appearance: { ...DEFAULT_SETTINGS.appearance, theme: 'light' },
      };
      mockInvoke.mockResolvedValue(finalSettings);

      const { result } = renderHook(() => useSettingsStore());

      // Updates to different sections
      act(() => {
        result.current.updateSettings('general', { language: 'ja' });
        result.current.updateSettings('appearance', { theme: 'light' });
      });

      // Fast-forward past debounce
      await act(async () => {
        vi.advanceTimersByTime(DEBOUNCE_DELAY_MS + 100);
        await vi.runAllTimersAsync();
      });

      // Should batch all sections into single call
      expect(mockInvoke).toHaveBeenCalledTimes(1);
      expect(mockInvoke).toHaveBeenCalledWith('update_settings', {
        partial: expect.objectContaining({
          general: { language: 'ja' },
          appearance: { theme: 'light' },
        }),
      });
    });
  });

});
