/**
 * useUpdate Hook
 *
 * Provides update functionality with state management.
 * Integrates with settings to respect "check for updates on startup" preference.
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { updateService, type UpdateInfo } from '@/services/updateService';
import { useSettings } from './useSettings';
import { createLogger } from '@/services/logger';

const logger = createLogger('useUpdate');

export interface UseUpdateState {
  /** Current update info */
  updateInfo: UpdateInfo | null;
  /** Whether currently checking for updates */
  isChecking: boolean;
  /** Whether currently downloading/installing */
  isInstalling: boolean;
  /** Error message if any */
  error: string | null;
  /** Whether an update is available */
  updateAvailable: boolean;
  /** Whether a restart is needed after installation */
  needsRestart: boolean;
}

export interface UseUpdateActions {
  /** Check for updates manually */
  checkForUpdates: () => Promise<UpdateInfo>;
  /** Download and install the available update */
  installUpdate: () => Promise<void>;
  /** Relaunch the application */
  relaunch: () => Promise<void>;
  /** Clear error state */
  clearError: () => void;
}

export interface UseUpdateReturn extends UseUpdateState, UseUpdateActions {}

export interface UseUpdateOptions {
  /** Check for updates on mount (respects settings) */
  checkOnMount?: boolean;
}

/**
 * Hook for managing application updates
 */
export function useUpdate(options: UseUpdateOptions = {}): UseUpdateReturn {
  const { checkOnMount = true } = options;

  const { general, isLoaded: settingsLoaded } = useSettings({ autoLoad: true });
  const hasCheckedRef = useRef(false);

  const [state, setState] = useState<UseUpdateState>({
    updateInfo: null,
    isChecking: false,
    isInstalling: false,
    error: null,
    updateAvailable: false,
    needsRestart: false,
  });

  // Check for updates
  const checkForUpdates = useCallback(async (): Promise<UpdateInfo> => {
    setState((prev) => ({ ...prev, isChecking: true, error: null }));

    try {
      const info = await updateService.checkForUpdates();
      setState((prev) => ({
        ...prev,
        updateInfo: info,
        isChecking: false,
        updateAvailable: info.available,
      }));
      return info;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setState((prev) => ({
        ...prev,
        isChecking: false,
        error: message,
      }));
      throw error;
    }
  }, []);

  // Install update
  const installUpdate = useCallback(async (): Promise<void> => {
    setState((prev) => ({ ...prev, isInstalling: true, error: null, needsRestart: false }));

    try {
      const needsRestart = await updateService.downloadAndInstallUpdate();
      setState((prev) => ({ ...prev, isInstalling: false, needsRestart }));
      if (needsRestart) {
        logger.info('Update installed, restart required');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setState((prev) => ({
        ...prev,
        isInstalling: false,
        needsRestart: false,
        error: message,
      }));
      throw error;
    }
  }, []);

  // Relaunch app
  const relaunch = useCallback(async (): Promise<void> => {
    try {
      await updateService.relaunchApp();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setState((prev) => ({ ...prev, error: message }));
      throw error;
    }
  }, []);

  // Clear error
  const clearError = useCallback(() => {
    setState((prev) => ({ ...prev, error: null }));
  }, []);

  // Check on mount if enabled in settings
  // Note: Use optional chaining for `general` as defense-in-depth against
  // potential race conditions during store hydration
  const shouldCheckOnStartup = general?.checkUpdatesOnStartup ?? false;

  useEffect(() => {
    if (checkOnMount && settingsLoaded && shouldCheckOnStartup && !hasCheckedRef.current) {
      hasCheckedRef.current = true;
      logger.info('Checking for updates on startup...');
      checkForUpdates().catch((e) => {
        logger.warn('Startup update check failed', { error: e });
      });
    }
  }, [checkOnMount, settingsLoaded, shouldCheckOnStartup, checkForUpdates]);

  return {
    ...state,
    checkForUpdates,
    installUpdate,
    relaunch,
    clearError,
  };
}

export default useUpdate;
