/**
 * useUpdate Hook Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

// Mock update service
vi.mock('@/services/updateService', () => ({
  updateService: {
    getCurrentVersion: vi.fn(),
    checkForUpdates: vi.fn(),
    downloadAndInstallUpdate: vi.fn(),
    relaunchApp: vi.fn(),
  },
}));

// Mock useSettings hook
vi.mock('./useSettings', () => ({
  useSettings: vi.fn(),
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

import { updateService } from '@/services/updateService';
import { useSettings } from './useSettings';
import { useUpdate } from './useUpdate';

const mockUpdateService = vi.mocked(updateService);
const mockUseSettings = vi.mocked(useSettings);

describe('useUpdate', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default settings mock
    mockUseSettings.mockReturnValue({
      settings: {} as any,
      isLoaded: true,
      isSaving: false,
      error: null,
      general: {
        language: 'en',
        showWelcomeOnStartup: true,
        hasCompletedSetup: false,
        recentProjectsLimit: 10,
        checkUpdatesOnStartup: false, // Default to false to prevent auto-check
        defaultProjectLocation: null,
      },
      editor: {} as any,
      playback: {} as any,
      export: {} as any,
      appearance: {} as any,
      shortcuts: {} as any,
      autoSave: {} as any,
      performance: {} as any,
      loadSettings: vi.fn(),
      saveSettings: vi.fn(),
      updateGeneral: vi.fn(),
      updateEditor: vi.fn(),
      updatePlayback: vi.fn(),
      updateExport: vi.fn(),
      updateAppearance: vi.fn(),
      updateShortcuts: vi.fn(),
      updateAutoSave: vi.fn(),
      updatePerformance: vi.fn(),
      resetSettings: vi.fn(),
      clearError: vi.fn(),
    });
  });

  describe('initial state', () => {
    it('should have correct initial state', () => {
      const { result } = renderHook(() => useUpdate({ checkOnMount: false }));

      expect(result.current.updateInfo).toBeNull();
      expect(result.current.isChecking).toBe(false);
      expect(result.current.isInstalling).toBe(false);
      expect(result.current.error).toBeNull();
      expect(result.current.updateAvailable).toBe(false);
      expect(result.current.needsRestart).toBe(false);
    });
  });

  describe('checkForUpdates', () => {
    it('should update state when checking', async () => {
      mockUpdateService.checkForUpdates.mockResolvedValue({
        available: true,
        currentVersion: '0.1.0',
        latestVersion: '0.2.0',
        releaseNotes: 'Bug fixes',
      });

      const { result } = renderHook(() => useUpdate({ checkOnMount: false }));

      await act(async () => {
        await result.current.checkForUpdates();
      });

      expect(result.current.updateInfo?.available).toBe(true);
      expect(result.current.updateInfo?.latestVersion).toBe('0.2.0');
      expect(result.current.updateAvailable).toBe(true);
      expect(result.current.isChecking).toBe(false);
    });

    it('should handle check error', async () => {
      mockUpdateService.checkForUpdates.mockRejectedValue(
        new Error('Network error')
      );

      const { result } = renderHook(() => useUpdate({ checkOnMount: false }));

      await act(async () => {
        try {
          await result.current.checkForUpdates();
        } catch {
          // Expected
        }
      });

      expect(result.current.error).toBe('Network error');
      expect(result.current.isChecking).toBe(false);
    });
  });

  describe('installUpdate', () => {
    it('should update state when installing', async () => {
      mockUpdateService.downloadAndInstallUpdate.mockResolvedValue(true);

      const { result } = renderHook(() => useUpdate({ checkOnMount: false }));

      await act(async () => {
        await result.current.installUpdate();
      });

      expect(result.current.isInstalling).toBe(false);
      expect(mockUpdateService.downloadAndInstallUpdate).toHaveBeenCalled();
    });

    it('should set needsRestart to true when update requires restart', async () => {
      mockUpdateService.downloadAndInstallUpdate.mockResolvedValue(true);

      const { result } = renderHook(() => useUpdate({ checkOnMount: false }));

      await act(async () => {
        await result.current.installUpdate();
      });

      expect(result.current.needsRestart).toBe(true);
      expect(result.current.isInstalling).toBe(false);
    });

    it('should set needsRestart to false when update does not require restart', async () => {
      mockUpdateService.downloadAndInstallUpdate.mockResolvedValue(false);

      const { result } = renderHook(() => useUpdate({ checkOnMount: false }));

      await act(async () => {
        await result.current.installUpdate();
      });

      expect(result.current.needsRestart).toBe(false);
      expect(result.current.isInstalling).toBe(false);
    });

    it('should handle install error', async () => {
      mockUpdateService.downloadAndInstallUpdate.mockRejectedValue(
        new Error('Install failed')
      );

      const { result } = renderHook(() => useUpdate({ checkOnMount: false }));

      await act(async () => {
        try {
          await result.current.installUpdate();
        } catch {
          // Expected
        }
      });

      expect(result.current.error).toBe('Install failed');
      expect(result.current.isInstalling).toBe(false);
      expect(result.current.needsRestart).toBe(false);
    });
  });

  describe('relaunch', () => {
    it('should call relaunch service', async () => {
      mockUpdateService.relaunchApp.mockResolvedValue(undefined);

      const { result } = renderHook(() => useUpdate({ checkOnMount: false }));

      await act(async () => {
        await result.current.relaunch();
      });

      expect(mockUpdateService.relaunchApp).toHaveBeenCalled();
    });
  });

  describe('clearError', () => {
    it('should clear error state', async () => {
      mockUpdateService.checkForUpdates.mockRejectedValue(
        new Error('Test error')
      );

      const { result } = renderHook(() => useUpdate({ checkOnMount: false }));

      await act(async () => {
        try {
          await result.current.checkForUpdates();
        } catch {
          // Expected
        }
      });

      expect(result.current.error).toBe('Test error');

      act(() => {
        result.current.clearError();
      });

      expect(result.current.error).toBeNull();
    });
  });

  describe('checkOnMount with settings', () => {
    it('should check on mount when setting is enabled', async () => {
      mockUseSettings.mockReturnValue({
        ...mockUseSettings(),
        isLoaded: true,
        general: {
          language: 'en',
          showWelcomeOnStartup: true,
          hasCompletedSetup: false,
          recentProjectsLimit: 10,
          checkUpdatesOnStartup: true,
          defaultProjectLocation: null,
        },
      });

      mockUpdateService.checkForUpdates.mockResolvedValue({
        available: false,
        currentVersion: '0.1.0',
      });

      renderHook(() => useUpdate({ checkOnMount: true }));

      await waitFor(() => {
        expect(mockUpdateService.checkForUpdates).toHaveBeenCalled();
      });
    });

    it('should not check on mount when setting is disabled', async () => {
      mockUseSettings.mockReturnValue({
        ...mockUseSettings(),
        isLoaded: true,
        general: {
          language: 'en',
          showWelcomeOnStartup: true,
          hasCompletedSetup: false,
          recentProjectsLimit: 10,
          checkUpdatesOnStartup: false,
          defaultProjectLocation: null,
        },
      });

      renderHook(() => useUpdate({ checkOnMount: true }));

      // Wait a bit to ensure no call is made
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(mockUpdateService.checkForUpdates).not.toHaveBeenCalled();
    });
  });
});
