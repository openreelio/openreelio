/**
 * useProjectHandlers Hook
 *
 * Manages project creation and opening operations with unsaved changes handling.
 * Extracts project handling logic from App.tsx for better separation of concerns.
 *
 * Features:
 * - Atomic project lifecycle operations with mutex protection
 * - Unsaved changes confirmation before destructive operations
 * - Path validation and sanitization for security
 * - Recent projects list management
 */

import { useCallback, useState, useRef } from 'react';
import { open, confirm } from '@tauri-apps/plugin-dialog';
import { useProjectStore } from '@/stores';
import { createLogger } from '@/services/logger';
import {
  addRecentProject,
  removeRecentProjectByPath,
  buildProjectPath,
  validateProjectName,
  getUserFriendlyError,
  type RecentProject,
} from '@/utils';
import type { ToastVariant } from '@/components/ui';

const logger = createLogger('useProjectHandlers');

// =============================================================================
// Types
// =============================================================================

export interface ProjectCreateData {
  name: string;
  path: string;
  format?: string;
}

export interface UseProjectHandlersOptions {
  /** Callback to update recent projects list */
  setRecentProjects: (projects: RecentProject[]) => void;
  /** Callback to show toast notifications */
  addToast: (message: string, variant?: ToastVariant) => void;
}

export interface UseProjectHandlersResult {
  /** Whether project creation dialog should be shown */
  showCreateDialog: boolean;
  /** Whether a project creation is in progress */
  isCreatingProject: boolean;
  /** Open the project creation dialog */
  handleNewProject: () => void;
  /** Handle project creation from dialog */
  handleCreateProject: (data: ProjectCreateData) => Promise<void>;
  /** Cancel project creation */
  handleCancelCreate: () => void;
  /** Open a project from path or show file picker */
  handleOpenProject: (path?: string) => Promise<void>;
}

// =============================================================================
// Hook Implementation
// =============================================================================

/**
 * Hook for managing project creation and opening operations.
 *
 * Handles:
 * - Creating new projects with validation
 * - Opening existing projects
 * - Checking for unsaved changes before operations
 * - Managing recent projects list
 *
 * @example
 * const {
 *   showCreateDialog,
 *   handleNewProject,
 *   handleOpenProject,
 * } = useProjectHandlers({
 *   recentProjects,
 *   setRecentProjects,
 *   addToast,
 * });
 */
export function useProjectHandlers({
  setRecentProjects,
  addToast,
}: UseProjectHandlersOptions): UseProjectHandlersResult {
  const { createProject, loadProject } = useProjectStore();

  // Project creation dialog state
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [isCreatingProject, setIsCreatingProject] = useState(false);

  // Mutex to prevent concurrent project operations
  // This prevents race conditions when user rapidly clicks create/open
  const operationInProgressRef = useRef(false);

  // Open the project creation dialog
  const handleNewProject = useCallback(() => {
    setShowCreateDialog(true);
  }, []);

  // Cancel project creation
  const handleCancelCreate = useCallback(() => {
    setShowCreateDialog(false);
  }, []);

  // Handle project creation from dialog
  const handleCreateProject = useCallback(
    async (data: ProjectCreateData) => {
      // Prevent concurrent operations
      if (operationInProgressRef.current) {
        logger.warn('Project operation already in progress');
        addToast('Please wait for the current operation to complete', 'warning');
        return;
      }

      operationInProgressRef.current = true;

      try {
        // Re-check state immediately before any action to minimize race window
        const { isDirty: hasUnsavedChanges, meta: currentMeta } = useProjectStore.getState();

        if (hasUnsavedChanges && currentMeta?.path) {
          const shouldSave = await confirm(
            'You have unsaved changes in the current project. Do you want to save before creating a new project?',
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
              const forceCreate = await confirm(
                'Failed to save the current project. Create new project anyway?',
                {
                  title: 'Save Failed',
                  kind: 'error',
                  okLabel: 'Create Anyway',
                  cancelLabel: 'Cancel',
                },
              );
              if (!forceCreate) {
                return;
              }
            }
          }
        }

        setIsCreatingProject(true);

        // Validate and sanitize project name to prevent path traversal
        const validation = validateProjectName(data.name);

        // Show warning if name was modified
        if (validation.errors.length > 0 && validation.sanitized) {
          // Log validation warnings but continue with sanitized name
          logger.warn('Project name validation warnings', { errors: validation.errors });
        }

        // Build safe project path using validated name
        const projectPath = buildProjectPath(data.path, data.name);
        const projectName = validation.sanitized || data.name;

        await createProject(projectName, projectPath);

        // Add to recent projects
        const updated = addRecentProject({
          name: projectName,
          path: projectPath,
        });
        setRecentProjects(updated);
        setShowCreateDialog(false);
        addToast(`Project "${projectName}" created successfully`, 'success');
      } catch (error) {
        logger.error('Failed to create project', { error });
        const friendlyMessage = getUserFriendlyError(error);
        addToast(`Could not create the project. ${friendlyMessage}`, 'error');
      } finally {
        setIsCreatingProject(false);
        operationInProgressRef.current = false;
      }
    },
    [createProject, addToast, setRecentProjects],
  );

  // Open a project from path or show file picker
  const handleOpenProject = useCallback(
    async (path?: string) => {
      // Prevent concurrent operations
      if (operationInProgressRef.current) {
        logger.warn('Project operation already in progress');
        addToast('Please wait for the current operation to complete', 'warning');
        return;
      }

      operationInProgressRef.current = true;

      try {
        // Re-check state immediately before any action to minimize race window
        const {
          isDirty: hasUnsavedChanges,
          meta: currentMeta,
        } = useProjectStore.getState();

        if (hasUnsavedChanges && currentMeta?.path) {
          const shouldSave = await confirm(
            'You have unsaved changes in the current project. Do you want to save before opening another project?',
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
              const forceOpen = await confirm(
                'Failed to save the current project. Open new project anyway?',
                {
                  title: 'Save Failed',
                  kind: 'error',
                  okLabel: 'Open Anyway',
                  cancelLabel: 'Cancel',
                },
              );
              if (!forceOpen) {
                return;
              }
            }
          }
        }

        let projectPath = path;

        if (!projectPath) {
          // Open file picker for project file
          const selectedPath = await open({
            directory: true,
            multiple: false,
            title: 'Open Project',
          });

          if (selectedPath && typeof selectedPath === 'string') {
            projectPath = selectedPath;
          }
        }

        if (projectPath) {
          try {
            await loadProject(projectPath);
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

            // If project not found, offer to remove from recent projects
            if (
              rawMessage.toLowerCase().includes('not found') ||
              rawMessage.toLowerCase().includes('no such file') ||
              rawMessage.toLowerCase().includes('project.json')
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
    [loadProject, addToast, setRecentProjects],
  );

  return {
    showCreateDialog,
    isCreatingProject,
    handleNewProject,
    handleCreateProject,
    handleCancelCreate,
    handleOpenProject,
  };
}
