/**
 * useAssetImport Hook
 *
 * Custom hook for importing assets with file dialog integration.
 * Provides file selection, import progress tracking, and error handling.
 */

import { useState, useCallback } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { useProjectStore } from '@/stores';

// =============================================================================
// Types
// =============================================================================

export interface UseAssetImportReturn {
  /** Whether import is in progress */
  isImporting: boolean;
  /** Error message if import failed */
  error: string | null;
  /** IDs of successfully imported assets */
  importedAssetIds: string[];
  /** Open file dialog and import selected files */
  importFiles: () => Promise<void>;
  /** Import files from given URIs (for drag-and-drop) */
  importFromUris: (uris: string[]) => Promise<void>;
  /** Clear error state */
  clearError: () => void;
  /** Reset all state */
  resetState: () => void;
}

// =============================================================================
// Constants
// =============================================================================

const MEDIA_FILTERS = [
  {
    name: 'Media Files',
    extensions: [
      'mp4', 'mov', 'avi', 'mkv', 'webm',
      'mp3', 'wav', 'aac', 'ogg', 'flac',
      'jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp',
    ],
  },
  {
    name: 'Video',
    extensions: ['mp4', 'mov', 'avi', 'mkv', 'webm'],
  },
  {
    name: 'Audio',
    extensions: ['mp3', 'wav', 'aac', 'ogg', 'flac'],
  },
  {
    name: 'Image',
    extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'],
  },
];

// =============================================================================
// Hook
// =============================================================================

/**
 * Hook for importing assets with file dialog integration
 *
 * @returns Import state and actions
 *
 * @example
 * const { importFiles, isImporting, error } = useAssetImport();
 * await importFiles(); // Opens file dialog and imports selected files
 */
export function useAssetImport(): UseAssetImportReturn {
  const { importAsset, selectAsset } = useProjectStore();

  const [isImporting, setIsImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [importedAssetIds, setImportedAssetIds] = useState<string[]>([]);

  /**
   * Import files from given URIs
   */
  const importFromUris = useCallback(
    async (uris: string[]) => {
      if (uris.length === 0 || isImporting) {
        return;
      }

      setIsImporting(true);
      setError(null);
      const successfulIds: string[] = [];
      let failedCount = 0;

      try {
        for (const uri of uris) {
          try {
            const assetId = await importAsset(uri);
            successfulIds.push(assetId);
          } catch {
            failedCount++;
          }
        }

        setImportedAssetIds(successfulIds);

        // Select the first imported asset
        if (successfulIds.length > 0) {
          selectAsset(successfulIds[0]);
        }

        if (failedCount > 0) {
          setError(`${failedCount} file(s) failed to import`);
        }
      } finally {
        setIsImporting(false);
      }
    },
    [importAsset, selectAsset, isImporting]
  );

  /**
   * Open file dialog and import selected files
   */
  const importFiles = useCallback(async () => {
    if (isImporting) {
      return;
    }

    setError(null);

    try {
      const selected = await open({
        multiple: true,
        title: 'Import Media Files',
        filters: MEDIA_FILTERS,
      });

      if (!selected) {
        return;
      }

      // Normalize to array
      const uris = Array.isArray(selected) ? selected : [selected];
      await importFromUris(uris);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setIsImporting(false);
    }
  }, [importFromUris, isImporting]);

  /**
   * Clear error state
   */
  const clearError = useCallback(() => {
    setError(null);
  }, []);

  /**
   * Reset all state
   */
  const resetState = useCallback(() => {
    setIsImporting(false);
    setError(null);
    setImportedAssetIds([]);
  }, []);

  return {
    isImporting,
    error,
    importedAssetIds,
    importFiles,
    importFromUris,
    clearError,
    resetState,
  };
}
