/**
 * useAppLifecycle Hook
 *
 * Manages application lifecycle events including:
 * - Window close handling with unsaved changes protection
 * - Backend cleanup (workers, services) before close
 * - Settings persistence on close
 * - Browser beforeunload fallback
 */

import { useEffect } from 'react';
import { isTauri as isTauriApi, invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { confirm } from '@tauri-apps/plugin-dialog';
import { useProjectStore, useSettingsStore } from '@/stores';
import { createLogger } from '@/services/logger';

const logger = createLogger('useAppLifecycle');

// =============================================================================
// Types
// =============================================================================

/** Result from backend cleanup operation */
interface AppCleanupResult {
  projectSaved: boolean;
  workersShutdown: boolean;
  error: string | null;
}

// =============================================================================
// Constants
// =============================================================================

/** Timeout for cleanup operations in milliseconds */
const CLEANUP_TIMEOUT_MS = 10000;

/** Timeout for settings flush on close (do not block app exit indefinitely) */
const SETTINGS_FLUSH_TIMEOUT_MS = 3000;

/** Hard deadline for the close handler to finish before forcing a window destroy */
const FORCE_CLOSE_DEADLINE_MS = 15000;

// =============================================================================
// Hook Implementation
// =============================================================================

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`${label} timeout`)), ms);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
    }
  });
}

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
    let isHandlingCloseRequest = false;

    const setupCloseHandler = async () => {
      try {
        const currentWindow = getCurrentWindow();

        unlisten = await currentWindow.onCloseRequested(async (event) => {
          const startedAt = Date.now();

          // We perform async work in this handler (prompts, IPC cleanup, settings flush).
          // Prevent the default close so we can explicitly destroy the window only after
          // cleanup finishes (or after our hard deadline forces a destroy).
          event.preventDefault();

          // If a close is already being handled (e.g., user clicked X repeatedly),
          // ignore duplicate requests but keep the window open until cleanup completes.
          if (isHandlingCloseRequest) {
            return;
          }
          isHandlingCloseRequest = true;
          let shouldClose = true;
          let destroySucceeded = false;

          // Fail-safe: if something in the close handler hangs (e.g., IPC never resolves),
          // force-destroy the window after a hard deadline so the user can always exit.
          const forceDestroyTimer = setTimeout(() => {
            logger.error('Close handler exceeded deadline; forcing window destroy', {
              elapsedMs: Date.now() - startedAt,
            });
            currentWindow.destroy().catch((err) => {
              logger.error('Forced window destroy failed', { error: err });
            });
          }, FORCE_CLOSE_DEADLINE_MS);

          try {
            const { isDirty, saveProject, meta } = useProjectStore.getState();

            // Check if there are unsaved changes
            if (isDirty && meta?.path) {
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
                    // User explicitly cancelled closing.
                    shouldClose = false;
                    return; // Don't close
                  }
                }
              }
            }

            // Perform backend cleanup with timeout
            logger.debug('Starting backend cleanup...');
            try {
              const result = await withTimeout(
                invoke<AppCleanupResult>('app_cleanup'),
                CLEANUP_TIMEOUT_MS,
                'Cleanup',
              );
              logger.info('Backend cleanup completed', { result });

              if (result.error) {
                logger.warn('Backend cleanup had errors', { error: result.error });
              }
            } catch (cleanupError) {
              // Don't block close on cleanup failure
              logger.error('Backend cleanup failed', { error: cleanupError });
            }

            // Flush settings (bounded by timeout so close cannot hang)
            logger.debug('Starting settings flush...');
            const { flushPendingUpdates } = useSettingsStore.getState();
            try {
              await withTimeout(
                flushPendingUpdates(),
                SETTINGS_FLUSH_TIMEOUT_MS,
                'Settings flush',
              );
              logger.debug('Settings flushed before close');
            } catch (flushError) {
              logger.error('Failed to flush settings on close', { error: flushError });
            }
            logger.debug('Cleanup phase complete, proceeding to window destroy...');

          } catch (error) {
            // Never throw from the close handler, otherwise the window may never be destroyed.
            logger.error('Unhandled error in close handler', { error });
          }

          // Handle the close decision outside of finally block to avoid unsafe return
          if (!shouldClose) {
            logger.info('Close request cancelled; keeping window open', {
              elapsedMs: Date.now() - startedAt,
            });
            clearTimeout(forceDestroyTimer);
            isHandlingCloseRequest = false;
            return;
          }

          // IMPORTANT: Do not call currentWindow.close() here (can deadlock).
          // We explicitly destroy the window after cleanup completes.
          try {
            logger.info('Close request approved; destroying window after cleanup', {
              elapsedMs: Date.now() - startedAt,
            });
            await currentWindow.destroy();
            destroySucceeded = true;
          } catch (destroyError) {
            // Keep the force-destroy timer armed so the user can still exit.
            logger.error('Window destroy failed', { error: destroyError });
          } finally {
            if (destroySucceeded) {
              clearTimeout(forceDestroyTimer);
            }
            // If destroy() fails for some reason, allow future close attempts.
            isHandlingCloseRequest = false;
          }
        });
      } catch (error) {
        logger.error('Failed to setup close handler', { error });
      }
    };

    if (isTauriApi()) {
      void setupCloseHandler();
    }

    // Browser-only beforeunload fallback:
    // In the Tauri runtime we rely on the native close event (onCloseRequested).
    const shouldRegisterBeforeUnload = !isTauriApi();
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

    if (shouldRegisterBeforeUnload) {
      window.addEventListener('beforeunload', handleBeforeUnload);
    }

    return () => {
      if (unlisten) {
        unlisten();
      }
      if (shouldRegisterBeforeUnload) {
        window.removeEventListener('beforeunload', handleBeforeUnload);
      }
    };
  }, []);
}
