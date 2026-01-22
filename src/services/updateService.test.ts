/**
 * Update Service Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock Tauri invoke
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

// Mock logger
vi.mock('./logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { invoke } from '@tauri-apps/api/core';
import {
  getCurrentVersion,
  checkForUpdates,
  downloadAndInstallUpdate,
  relaunchApp,
} from './updateService';

const mockInvoke = vi.mocked(invoke);

describe('updateService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getCurrentVersion', () => {
    it('should return current version from backend', async () => {
      mockInvoke.mockResolvedValueOnce('0.1.0');

      const version = await getCurrentVersion();

      expect(mockInvoke).toHaveBeenCalledWith('get_current_version');
      expect(version).toBe('0.1.0');
    });

    it('should return "unknown" on error', async () => {
      mockInvoke.mockRejectedValueOnce(new Error('Backend error'));

      const version = await getCurrentVersion();

      expect(version).toBe('unknown');
    });
  });

  describe('checkForUpdates', () => {
    it('should return update info when update is available', async () => {
      mockInvoke
        .mockResolvedValueOnce({
          status: 'available',
          version: '0.2.0',
          notes: 'Bug fixes',
          date: '2024-01-15',
          message: null,
        })
        .mockResolvedValueOnce('0.1.0'); // getCurrentVersion call

      const info = await checkForUpdates();

      expect(mockInvoke).toHaveBeenCalledWith('check_for_updates');
      expect(info.available).toBe(true);
      expect(info.latestVersion).toBe('0.2.0');
      expect(info.releaseNotes).toBe('Bug fixes');
    });

    it('should return no update when up to date', async () => {
      mockInvoke.mockResolvedValueOnce({
        status: 'upToDate',
        version: '0.1.0',
        notes: null,
        date: null,
        message: null,
      });

      const info = await checkForUpdates();

      expect(info.available).toBe(false);
      expect(info.currentVersion).toBe('0.1.0');
    });

    it('should handle error status gracefully', async () => {
      mockInvoke
        .mockResolvedValueOnce({
          status: 'error',
          version: null,
          notes: null,
          date: null,
          message: 'Network error',
        })
        .mockResolvedValueOnce('0.1.0');

      const info = await checkForUpdates();

      expect(info.available).toBe(false);
    });

    it('should handle backend error gracefully', async () => {
      mockInvoke.mockRejectedValueOnce(new Error('Backend error')).mockResolvedValueOnce('0.1.0');

      const info = await checkForUpdates();

      expect(info.available).toBe(false);
      expect(info.currentVersion).toBe('0.1.0');
    });
  });

  describe('downloadAndInstallUpdate', () => {
    it('should return true when restart is needed', async () => {
      mockInvoke.mockResolvedValueOnce(true);

      const needsRestart = await downloadAndInstallUpdate();

      expect(mockInvoke).toHaveBeenCalledWith('download_and_install_update');
      expect(needsRestart).toBe(true);
    });

    it('should throw on error', async () => {
      mockInvoke.mockRejectedValueOnce(new Error('Download failed'));

      await expect(downloadAndInstallUpdate()).rejects.toThrow('Download failed');
    });
  });

  describe('relaunchApp', () => {
    it('should call relaunch command', async () => {
      mockInvoke.mockResolvedValueOnce(undefined);

      await relaunchApp();

      expect(mockInvoke).toHaveBeenCalledWith('relaunch_app');
    });

    it('should throw on error', async () => {
      mockInvoke.mockRejectedValueOnce(new Error('Relaunch failed'));

      await expect(relaunchApp()).rejects.toThrow('Relaunch failed');
    });
  });
});
