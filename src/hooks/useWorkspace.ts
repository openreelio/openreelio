/**
 * useWorkspace Hook
 *
 * Provides workspace operations for scanning, file registration,
 * and drag-to-timeline workflows.
 */

import { useCallback, useMemo } from 'react';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { useProjectStore } from '@/stores';
import { refreshProjectState } from '@/utils/stateRefreshHelper';
import { createLogger } from '@/services/logger';
import type { AssetKind, FileTreeEntry } from '@/types';

const logger = createLogger('useWorkspace');

export interface UseWorkspaceReturn {
  /** Full file tree */
  fileTree: FileTreeEntry[];
  /** Whether a scan is in progress */
  isScanning: boolean;
  /** Trigger a workspace scan */
  scanWorkspace: () => Promise<void>;
  /** Register a workspace file and return its asset ID */
  registerAndGetAssetId: (relativePath: string) => Promise<string | null>;
  /** Check if a file is already registered as an asset */
  isFileRegistered: (relativePath: string) => boolean;
  /** Find files by name (case-insensitive substring match) */
  findFileByName: (name: string) => FileTreeEntry[];
  /** Find files by asset kind */
  findFilesByKind: (kind: AssetKind) => FileTreeEntry[];
  /** Get all unregistered files (files without an asset ID) */
  getUnregisteredFiles: () => FileTreeEntry[];
}

/**
 * Recursively flattens a file tree into a flat list of leaf (non-directory) entries.
 */
function flattenTree(entries: FileTreeEntry[]): FileTreeEntry[] {
  const result: FileTreeEntry[] = [];
  for (const entry of entries) {
    if (entry.isDirectory) {
      result.push(...flattenTree(entry.children));
    } else {
      result.push(entry);
    }
  }
  return result;
}

export function useWorkspace(): UseWorkspaceReturn {
  const fileTree = useWorkspaceStore((state) => state.fileTree);
  const isScanning = useWorkspaceStore((state) => state.isScanning);
  const scanWorkspace = useWorkspaceStore((state) => state.scanWorkspace);
  const registerFile = useWorkspaceStore((state) => state.registerFile);

  // Flat list of all files for search operations
  const flatFiles = useMemo(() => flattenTree(fileTree), [fileTree]);

  const registerAndGetAssetId = useCallback(
    async (relativePath: string): Promise<string | null> => {
      const result = await registerFile(relativePath);
      if (!result) {
        return null;
      }

      // If newly registered, refresh project assets (lighter than full loadProject)
      const assetMissingInStore = !useProjectStore.getState().assets.has(result.assetId);
      if (!result.alreadyRegistered || assetMissingInStore) {
        try {
          const freshState = await refreshProjectState();
          useProjectStore.setState((draft) => {
            draft.assets = freshState.assets;
          });
        } catch {
          logger.warn('Could not refresh project state after registration');
        }
      }

      return result.assetId;
    },
    [registerFile],
  );

  const isFileRegistered = useCallback(
    (relativePath: string): boolean => {
      return flatFiles.some((f) => f.relativePath === relativePath && f.assetId != null);
    },
    [flatFiles],
  );

  const findFileByName = useCallback(
    (name: string): FileTreeEntry[] => {
      const lowerName = name.toLowerCase();
      return flatFiles.filter((f) => f.name.toLowerCase().includes(lowerName));
    },
    [flatFiles],
  );

  const findFilesByKind = useCallback(
    (kind: AssetKind): FileTreeEntry[] => {
      return flatFiles.filter((f) => f.kind === kind);
    },
    [flatFiles],
  );

  const getUnregisteredFiles = useCallback((): FileTreeEntry[] => {
    return flatFiles.filter((f) => f.assetId == null);
  }, [flatFiles]);

  return {
    fileTree,
    isScanning,
    scanWorkspace,
    registerAndGetAssetId,
    isFileRegistered,
    findFileByName,
    findFilesByKind,
    getUnregisteredFiles,
  };
}
