/**
 * Update Service
 *
 * Handles application update checking, downloading, and installation.
 * Uses tauri-plugin-updater for native update functionality.
 */

import { invoke } from '@tauri-apps/api/core';
import { createLogger } from './logger';

const logger = createLogger('UpdateService');

// =============================================================================
// Types
// =============================================================================

/** Update check result status */
export type UpdateCheckStatus = 'available' | 'upToDate' | 'error';

/** Update check result from backend */
export interface UpdateCheckResult {
  status: UpdateCheckStatus;
  version: string | null;
  notes: string | null;
  date: string | null;
  message: string | null;
}

/** Update availability information */
export interface UpdateInfo {
  available: boolean;
  currentVersion: string;
  latestVersion?: string;
  releaseNotes?: string;
  releaseDate?: string;
}

// =============================================================================
// Service Functions
// =============================================================================

/**
 * Gets the current application version
 */
export async function getCurrentVersion(): Promise<string> {
  try {
    return await invoke<string>('get_current_version');
  } catch (error) {
    logger.error('Failed to get current version', { error });
    return 'unknown';
  }
}

/**
 * Checks for available updates
 */
export async function checkForUpdates(): Promise<UpdateInfo> {
  try {
    logger.info('Checking for updates...');
    const result = await invoke<UpdateCheckResult>('check_for_updates');

    if (result.status === 'available') {
      logger.info('Update available', {
        version: result.version,
        date: result.date,
      });
      return {
        available: true,
        currentVersion: await getCurrentVersion(),
        latestVersion: result.version ?? undefined,
        releaseNotes: result.notes ?? undefined,
        releaseDate: result.date ?? undefined,
      };
    } else if (result.status === 'upToDate') {
      logger.info('Application is up to date', { version: result.version });
      return {
        available: false,
        currentVersion: result.version ?? (await getCurrentVersion()),
      };
    } else {
      // Error case
      logger.warn('Update check failed', { message: result.message });
      return {
        available: false,
        currentVersion: await getCurrentVersion(),
      };
    }
  } catch (error) {
    logger.error('Failed to check for updates', { error });
    return {
      available: false,
      currentVersion: await getCurrentVersion(),
    };
  }
}

/**
 * Downloads and installs an available update
 * Returns true if a restart is needed
 */
export async function downloadAndInstallUpdate(): Promise<boolean> {
  try {
    logger.info('Downloading and installing update...');
    const needsRestart = await invoke<boolean>('download_and_install_update');
    logger.info('Update installed', { needsRestart });
    return needsRestart;
  } catch (error) {
    logger.error('Failed to download/install update', { error });
    throw error;
  }
}

/**
 * Relaunches the application after an update
 */
export async function relaunchApp(): Promise<void> {
  try {
    logger.info('Relaunching application...');
    await invoke('relaunch_app');
  } catch (error) {
    logger.error('Failed to relaunch application', { error });
    throw error;
  }
}

// =============================================================================
// Export
// =============================================================================

export const updateService = {
  getCurrentVersion,
  checkForUpdates,
  downloadAndInstallUpdate,
  relaunchApp,
};

export default updateService;
