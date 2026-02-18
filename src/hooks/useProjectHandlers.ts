/**
 * useProjectHandlers Hook
 *
 * Manages project opening operations with unsaved changes handling.
 * Uses a folder-based workspace model where any folder can be opened as a project.
 * If the folder doesn't contain project files, they are initialized automatically.
 *
 * Features:
 * - Atomic project lifecycle operations with mutex protection
 * - Unsaved changes confirmation before destructive operations
 * - Recent projects list management
 */

import { useCallback, useRef } from 'react';
import { open, confirm } from '@tauri-apps/plugin-dialog';
import { useProjectStore } from '@/stores';
import { createLogger } from '@/services/logger';
// Direct imports instead of barrel to avoid bundling all utilities
import {
  addRecentProject,
  removeRecentProjectByPath,
  type RecentProject,
} from '@/utils/recentProjects';
import { getUserFriendlyError } from '@/utils/errorMessages';
import type { ToastVariant } from '@/components/ui';

const logger = createLogger('useProjectHandlers');

// =============================================================================
// Types
// =============================================================================

export interface UseProjectHandlersOptions {
  /** Callback to update recent projects list */
  setRecentProjects: (projects: RecentProject[]) => void;
  /** Callback to show toast notifications */
  addToast: (message: string, variant?: ToastVariant) => void;
}

export interface UseProjectHandlersResult {
  /** Open a folder as project (shows folder picker or uses provided path) */
  handleOpenFolder: (path?: string) => Promise<void>;
}

// =============================================================================
// Hook Implementation
// =============================================================================

/**
 * Hook for managing project opening operations using folder-based workspace model.
 *
 * Handles:
 * - Opening any folder as a project (auto-initializes if needed)
 * - Checking for unsaved changes before operations
 * - Managing recent projects list
 *
 * @example
 * const { handleOpenFolder } = useProjectHandlers({
 *   setRecentProjects,
 *   addToast,
 * });
 */
export function useProjectHandlers({
  setRecentProjects,
  addToast,
}: UseProjectHandlersOptions): UseProjectHandlersResult {
  const { openOrInitProject } = useProjectStore();

  // Mutex to prevent concurrent project operations
  // This prevents race conditions when user rapidly clicks buttons
  const operationInProgressRef = useRef(false);

  /**
   * Checks for unsaved changes and prompts the user to save.
   * Returns true if it's safe to proceed, false if user cancelled.
   */
  const confirmUnsavedChanges = useCallback(
    async (actionLabel: string): Promise<boolean> => {
      const { isDirty: hasUnsavedChanges, meta: currentMeta } = useProjectStore.getState();

      if (!hasUnsavedChanges || !currentMeta?.path) {
        return true;
      }

      const shouldSave = await confirm(
        `You have unsaved changes in the current project. Do you want to save before ${actionLabel}?`,
        {
          title: 'Unsaved Changes',
          kind: 'warning',
          okLabel: 'Save and Continue',
          cancelLabel: 'Discard Changes',
        },
      );

      if (shouldSave) {
        try {
          // Re-verify dirty state hasn't changed during dialog
          const latestState = useProjectStore.getState();
          if (latestState.isDirty && latestState.meta?.path) {
            await latestState.saveProject();
            addToast('Project saved', 'success');
          }
        } catch (saveError) {
          logger.error('Failed to save current project', { error: saveError });
          const forceProceed = await confirm(
            `Failed to save the current project. ${actionLabel.charAt(0).toUpperCase() + actionLabel.slice(1)} anyway?`,
            {
              title: 'Save Failed',
              kind: 'error',
              okLabel: 'Continue Anyway',
              cancelLabel: 'Cancel',
            },
          );
          if (!forceProceed) {
            return false;
          }
        }
      }

      return true;
    },
    [addToast],
  );

  // Open a folder as project (shows folder picker if no path provided)
  const handleOpenFolder = useCallback(
    async (path?: string) => {
      // Prevent concurrent operations
      if (operationInProgressRef.current) {
        logger.warn('Project operation already in progress');
        addToast('Please wait for the current operation to complete', 'warning');
        return;
      }

      operationInProgressRef.current = true;

      try {
        // Check for unsaved changes
        const canProceed = await confirmUnsavedChanges('opening another project');
        if (!canProceed) {
          return;
        }

        let projectPath = path;

        if (!projectPath) {
          // Open folder picker
          const selectedPath = await open({
            directory: true,
            multiple: false,
            title: 'Open Folder',
          });

          if (selectedPath && typeof selectedPath === 'string') {
            projectPath = selectedPath;
          }
        }

        if (projectPath) {
          try {
            await openOrInitProject(projectPath);
            // Add to recent projects
            const folderName = projectPath.split(/[/\\]/).pop() || 'Untitled';
            const updated = addRecentProject({
              name: folderName,
              path: projectPath,
            });
            setRecentProjects(updated);
            addToast(`Project opened: ${folderName}`, 'success');
          } catch (error) {
            logger.error('Failed to open project', { error, path: projectPath });
            const rawMessage = error instanceof Error ? error.message : String(error);
            const friendlyMessage = getUserFriendlyError(error);

            // If path not found, offer to remove from recent projects
            if (
              rawMessage.toLowerCase().includes('not found') ||
              rawMessage.toLowerCase().includes('no such file')
            ) {
              addToast(`${friendlyMessage} The project may have been moved or deleted.`, 'error');
              // Remove the invalid project from recent projects
              const updated = removeRecentProjectByPath(projectPath);
              setRecentProjects(updated);
            } else {
              addToast(friendlyMessage, 'error');
            }
          }
        }
      } finally {
        operationInProgressRef.current = false;
      }
    },
    [openOrInitProject, addToast, setRecentProjects, confirmUnsavedChanges],
  );

  return {
    handleOpenFolder,
  };
}
