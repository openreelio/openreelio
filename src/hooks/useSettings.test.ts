/**
 * useSettings Hook Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

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
import { useSettings } from './useSettings';
import { useSettingsStore, type AppSettings } from '@/stores/settingsStore';

const mockInvoke = vi.mocked(invoke);

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
};

describe('useSettings', () => {
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

  describe('auto-loading', () => {
    it('should auto-load settings on mount by default', async () => {
      mockInvoke.mockResolvedValueOnce(DEFAULT_SETTINGS);

      renderHook(() => useSettings());

      await waitFor(() => {
        expect(mockInvoke).toHaveBeenCalledWith('get_settings');
      });
    });

    it('should not auto-load when autoLoad is false', async () => {
      renderHook(() => useSettings({ autoLoad: false }));

      // Wait a bit to ensure no call is made
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(mockInvoke).not.toHaveBeenCalled();
    });

    it('should not re-load if already loaded', async () => {
      useSettingsStore.setState({ isLoaded: true });

      renderHook(() => useSettings());

      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(mockInvoke).not.toHaveBeenCalled();
    });
  });

  describe('section selectors', () => {
    it('should provide access to all settings sections', () => {
      useSettingsStore.setState({ isLoaded: true });

      const { result } = renderHook(() => useSettings({ autoLoad: false }));

      expect(result.current.general.language).toBe('en');
      expect(result.current.editor.snapToGrid).toBe(true);
      expect(result.current.playback.defaultVolume).toBe(0.8);
      expect(result.current.export.defaultFormat).toBe('mp4');
      expect(result.current.appearance.theme).toBe('dark');
      expect(result.current.shortcuts.customShortcuts).toEqual({});
      expect(result.current.autoSave.enabled).toBe(true);
      expect(result.current.performance.hardwareAcceleration).toBe(true);
    });
  });

  describe('section updaters', () => {
    it('should update general settings', async () => {
      mockInvoke.mockResolvedValueOnce({
        ...DEFAULT_SETTINGS,
        general: { ...DEFAULT_SETTINGS.general, language: 'ko' },
      });
      useSettingsStore.setState({ isLoaded: true });

      const { result } = renderHook(() => useSettings({ autoLoad: false }));

      await act(async () => {
        await result.current.updateGeneral({ language: 'ko' });
      });

      expect(result.current.general.language).toBe('ko');
      expect(mockInvoke).toHaveBeenCalledWith('update_settings', {
        partial: { general: { language: 'ko' } },
      });
    });

    it('should update appearance settings', async () => {
      mockInvoke.mockResolvedValueOnce({
        ...DEFAULT_SETTINGS,
        appearance: { ...DEFAULT_SETTINGS.appearance, theme: 'light' },
      });
      useSettingsStore.setState({ isLoaded: true });

      const { result } = renderHook(() => useSettings({ autoLoad: false }));

      await act(async () => {
        await result.current.updateAppearance({ theme: 'light' });
      });

      expect(result.current.appearance.theme).toBe('light');
    });

    it('should update editor settings', async () => {
      mockInvoke.mockResolvedValueOnce({
        ...DEFAULT_SETTINGS,
        editor: { ...DEFAULT_SETTINGS.editor, snapToGrid: false },
      });
      useSettingsStore.setState({ isLoaded: true });

      const { result } = renderHook(() => useSettings({ autoLoad: false }));

      await act(async () => {
        await result.current.updateEditor({ snapToGrid: false });
      });

      expect(result.current.editor.snapToGrid).toBe(false);
    });
  });

  describe('state access', () => {
    it('should expose isLoaded state', () => {
      useSettingsStore.setState({ isLoaded: true });

      const { result } = renderHook(() => useSettings({ autoLoad: false }));

      expect(result.current.isLoaded).toBe(true);
    });

    it('should expose isSaving state', () => {
      useSettingsStore.setState({ isSaving: true, isLoaded: true });

      const { result } = renderHook(() => useSettings({ autoLoad: false }));

      expect(result.current.isSaving).toBe(true);
    });

    it('should expose error state', () => {
      useSettingsStore.setState({ error: 'Test error', isLoaded: true });

      const { result } = renderHook(() => useSettings({ autoLoad: false }));

      expect(result.current.error).toBe('Test error');
    });
  });
});
