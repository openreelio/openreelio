/**
 * useAppLifecycle Hook
 *
 * Manages application lifecycle events including:
 * - Window close handling with unsaved changes protection
 * - Settings persistence on close
 * - Browser beforeunload fallback
 */

import { useEffect } from 'react';
import { isTauri as isTauriApi } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { confirm } from '@tauri-apps/plugin-dialog';
import { useProjectStore, useSettingsStore } from '@/stores';
import { createLogger } from '@/services/logger';

const logger = createLogger('useAppLifecycle');

// =============================================================================
// Hook Implementation
// =============================================================================

/**
 * Hook that manages application lifecycle events.
 *
 * Handles:
 * - Window close requests with unsaved changes confirmation
 * - Automatic settings flush on close
 * - Browser beforeunload fallback for web environments
 *
 * @example
 * // In your main App component:
 * useAppLifecycle();
 */
export function useAppLifecycle(): void {
  useEffect(() => {
    let unlisten: (() => void) | undefined;

    const setupCloseHandler = async () => {
      try {
        const currentWindow = getCurrentWindow();

        unlisten = await currentWindow.onCloseRequested(async (event) => {
          const { isDirty, saveProject, meta } = useProjectStore.getState();

          // Check if there are unsaved changes
          if (isDirty && meta?.path) {
            // Prevent immediate close
            event.preventDefault();

            // Ask user what to do
            const shouldSave = await confirm(
              'You have unsaved changes. Do you want to save before closing?',
              {
                title: 'Unsaved Changes',
                kind: 'warning',
                okLabel: 'Save and Close',
                cancelLabel: 'Close Without Saving',
              },
            );

            if (shouldSave) {
              try {
                await saveProject();
                logger.info('Project saved before closing');
              } catch (saveError) {
                logger.error('Failed to save project before closing', { error: saveError });
                // Ask if they still want to close
                const forceClose = await confirm(
                  'Failed to save project. Close anyway?',
                  {
                    title: 'Save Failed',
                    kind: 'error',
                    okLabel: 'Close Anyway',
                    cancelLabel: 'Cancel',
                  },
                );
                if (!forceClose) {
                  return; // Don't close
                }
              }
            }

            // Flush settings
            const { flushPendingUpdates } = useSettingsStore.getState();
            try {
              await flushPendingUpdates();
            } catch (flushError) {
              logger.error('Failed to flush settings on close', { error: flushError });
            }

            // Now close the window
            await currentWindow.close();
          } else {
            // No unsaved changes, just flush settings
            const { flushPendingUpdates } = useSettingsStore.getState();
            try {
              await flushPendingUpdates();
            } catch (flushError) {
              logger.error('Failed to flush settings on close', { error: flushError });
            }
          }
        });
      } catch (error) {
        logger.error('Failed to setup close handler', { error });
      }
    };

    if (isTauriApi()) {
      void setupCloseHandler();
    }

    // Also handle browser beforeunload as fallback
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      const { isDirty, meta } = useProjectStore.getState();

      if (isDirty && meta?.path) {
        // Show browser's native confirmation dialog
        e.preventDefault();
        e.returnValue = 'You have unsaved changes.';
        return 'You have unsaved changes.';
      }

      // Synchronously trigger flush - the promise won't complete before unload,
      // but starting it gives the best chance of saving
      const { flushPendingUpdates } = useSettingsStore.getState();
      flushPendingUpdates().catch((flushError: unknown) => {
        logger.error('Failed to flush pending settings on unload', { error: flushError });
      });
    };

    window.addEventListener('beforeunload', handleBeforeUnload);

    return () => {
      if (unlisten) {
        unlisten();
      }
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, []);
}
