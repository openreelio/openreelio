/**
 * useWorkspace Hook
 *
 * Provides workspace operations for scanning, file search,
 * and drag-to-timeline workflows.
 *
 * In the filesystem-first model all discovered files are auto-registered
 * as assets by the backend, so explicit registration is no longer needed.
 */

import { useCallback, useMemo } from 'react';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import type { AssetKind, FileTreeEntry } from '@/types';

export interface UseWorkspaceReturn {
  /** Full file tree */
  fileTree: FileTreeEntry[];
  /** Whether a scan is in progress */
  isScanning: boolean;
  /** Trigger a workspace scan */
  scanWorkspace: () => Promise<void>;
  /**
   * Look up the asset ID for a workspace file.
   * Returns null if the file is not yet auto-registered.
   */
  getAssetIdForFile: (relativePath: string) => string | null;
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

  // Flat list of all files for search operations
  const flatFiles = useMemo(() => flattenTree(fileTree), [fileTree]);

  const getAssetIdForFile = useCallback(
    (relativePath: string): string | null => {
      const file = flatFiles.find((f) => f.relativePath === relativePath);
      return file?.assetId ?? null;
    },
    [flatFiles],
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
    getAssetIdForFile,
    isFileRegistered,
    findFileByName,
    findFilesByKind,
    getUnregisteredFiles,
  };
}
