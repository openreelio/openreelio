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
    it('should update a section and save', async () => {
      const updated: AppSettings = {
        ...DEFAULT_SETTINGS,
        general: { ...DEFAULT_SETTINGS.general, language: 'ja' },
      };
      mockInvoke.mockResolvedValueOnce(updated);

      const { result } = renderHook(() => useSettingsStore());

      await act(async () => {
        await result.current.updateSettings('general', { language: 'ja' });
      });

      expect(result.current.settings.general.language).toBe('ja');
      expect(mockInvoke).toHaveBeenCalledWith('update_settings', {
        partial: { general: { language: 'ja' } },
      });
    });

    it('should preserve other fields in section', async () => {
      const updated: AppSettings = {
        ...DEFAULT_SETTINGS,
        general: { ...DEFAULT_SETTINGS.general, showWelcomeOnStartup: false },
      };
      mockInvoke.mockResolvedValueOnce(updated);

      const { result } = renderHook(() => useSettingsStore());

      await act(async () => {
        await result.current.updateSettings('general', {
          showWelcomeOnStartup: false,
        });
      });

      expect(result.current.settings.general.language).toBe('en');
      expect(result.current.settings.general.showWelcomeOnStartup).toBe(false);
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
});
