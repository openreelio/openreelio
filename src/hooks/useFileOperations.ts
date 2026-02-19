/**
 * useFileOperations Hook
 *
 * Wraps filesystem IPC operations with error handling.
 */

import { useCallback } from 'react';
import { useWorkspaceStore } from '@/stores';
import {
  revealInExplorerFromBackend,
} from '@/services/workspaceGateway';
import { createLogger } from '@/services/logger';

const logger = createLogger('useFileOperations');

export interface UseFileOperationsReturn {
  createFolder: (relativePath: string) => Promise<void>;
  renameFile: (oldPath: string, newName: string) => Promise<void>;
  moveFile: (sourcePath: string, destFolder: string) => Promise<void>;
  deleteFile: (relativePath: string) => Promise<void>;
  revealInExplorer: (relativePath: string) => Promise<void>;
}

export function useFileOperations(): UseFileOperationsReturn {
  const createFolder = useCallback(async (relativePath: string) => {
    await useWorkspaceStore.getState().createFolder(relativePath);
  }, []);

  const renameFile = useCallback(async (oldPath: string, newName: string) => {
    await useWorkspaceStore.getState().renameFile(oldPath, newName);
  }, []);

  const moveFile = useCallback(async (sourcePath: string, destFolder: string) => {
    await useWorkspaceStore.getState().moveFile(sourcePath, destFolder);
  }, []);

  const deleteFile = useCallback(async (relativePath: string) => {
    await useWorkspaceStore.getState().deleteFile(relativePath);
  }, []);

  const revealInExplorer = useCallback(async (relativePath: string) => {
    try {
      await revealInExplorerFromBackend(relativePath);
    } catch (error) {
      logger.error('Failed to reveal in explorer', { error });
    }
  }, []);

  return { createFolder, renameFile, moveFile, deleteFile, revealInExplorer };
}
