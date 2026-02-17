/**
 * useProject Hook
 *
 * Custom hook for project management operations.
 * Wraps projectStore with a cleaner API and computed values.
 */

import { useMemo, useCallback } from 'react';
import { useProjectStore } from '@/stores';

// =============================================================================
// Types
// =============================================================================

export interface UseProjectReturn {
  // State
  isLoaded: boolean;
  isLoading: boolean;
  isDirty: boolean;
  meta: {
    id: string;
    name: string;
    path: string;
    createdAt: string;
    modifiedAt: string;
  } | null;
  error: string | null;

  // Computed
  hasProject: boolean;
  projectName: string | undefined;
  assetCount: number;

  // Actions
  createProject: (name: string, path: string) => Promise<void>;
  loadProject: (path: string) => Promise<void>;
  saveProject: () => Promise<void>;
  closeProject: () => Promise<void>;
  importAsset: (uri: string) => Promise<string>;
  removeAsset: (assetId: string) => Promise<void>;
}

// =============================================================================
// Hook
// =============================================================================

/**
 * Hook for managing project lifecycle and operations
 *
 * @returns Project state and actions
 *
 * @example
 * const { isLoaded, createProject, projectName } = useProject();
 *
 * if (!isLoaded) {
 *   return <WelcomeScreen onNewProject={() => createProject('My Project', '/path')} />;
 * }
 */
export function useProject(): UseProjectReturn {
  // Get state from store
  const isLoaded = useProjectStore((state) => state.isLoaded);
  const isLoading = useProjectStore((state) => state.isLoading);
  const isDirty = useProjectStore((state) => state.isDirty);
  const meta = useProjectStore((state) => state.meta);
  const error = useProjectStore((state) => state.error);
  const assets = useProjectStore((state) => state.assets);

  // Get actions from store
  const storeCreateProject = useProjectStore((state) => state.createProject);
  const storeLoadProject = useProjectStore((state) => state.loadProject);
  const storeSaveProject = useProjectStore((state) => state.saveProject);
  const storeCloseProject = useProjectStore((state) => state.closeProject);
  const storeImportAsset = useProjectStore((state) => state.importAsset);
  const storeRemoveAsset = useProjectStore((state) => state.removeAsset);

  // Computed values
  const hasProject = isLoaded && meta !== null;
  const projectName = meta?.name;
  const assetCount = useMemo(() => assets.size, [assets]);

  // Wrapped actions with stable references
  const createProject = useCallback(
    async (name: string, path: string): Promise<void> => {
      await storeCreateProject(name, path);
    },
    [storeCreateProject]
  );

  const loadProject = useCallback(
    async (path: string): Promise<void> => {
      await storeLoadProject(path);
    },
    [storeLoadProject]
  );

  const saveProject = useCallback(async (): Promise<void> => {
    await storeSaveProject();
  }, [storeSaveProject]);

  const closeProject = useCallback(async (): Promise<void> => {
    await storeCloseProject();
  }, [storeCloseProject]);

  const importAsset = useCallback(
    async (uri: string): Promise<string> => {
      return await storeImportAsset(uri);
    },
    [storeImportAsset]
  );

  const removeAsset = useCallback(
    async (assetId: string): Promise<void> => {
      await storeRemoveAsset(assetId);
    },
    [storeRemoveAsset]
  );

  return {
    // State
    isLoaded,
    isLoading,
    isDirty,
    meta,
    error,

    // Computed
    hasProject,
    projectName,
    assetCount,

    // Actions
    createProject,
    loadProject,
    saveProject,
    closeProject,
    importAsset,
    removeAsset,
  };
}
