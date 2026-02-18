/**
 * Bin Operations Hook
 *
 * Provides bin CRUD operations that persist to the backend.
 * Uses projectStore.executeCommand for all operations to ensure:
 * - Backend persistence via event sourcing
 * - Undo/redo support
 * - State synchronization
 */

import { useCallback } from 'react';
import { useProjectStore } from '@/stores/projectStore';
import { useBinStore } from '@/stores/binStore';
import { getBinDescendants } from '@/utils/binUtils';
import { createLogger } from '@/services/logger';
import type { BinColor } from '@/types';

const logger = createLogger('BinOperations');

/**
 * Hook for bin operations that persist to the backend.
 *
 * @example
 * ```tsx
 * const { createBin, deleteBin, renameBin, moveBin, setBinColor } = useBinOperations();
 *
 * // Create a new bin
 * await createBin('My Folder', null); // root level
 * await createBin('Subfolder', parentBinId); // nested
 *
 * // Rename a bin
 * await renameBin(binId, 'New Name');
 *
 * // Move a bin
 * await moveBin(binId, newParentId);
 *
 * // Set bin color
 * await setBinColor(binId, 'blue');
 *
 * // Delete a bin
 * await deleteBin(binId);
 * ```
 */
export function useBinOperations() {
  const executeCommand = useProjectStore((state) => state.executeCommand);
  const { selectBin, startEditing } = useBinStore();

  /**
   * Creates a new bin and persists it to the backend.
   * Automatically starts editing the new bin for inline rename.
   */
  const createBin = useCallback(
    async (name: string, parentId: string | null, color?: BinColor) => {
      try {
        const result = await executeCommand({
          type: 'CreateBin',
          payload: {
            name,
            parentId: parentId ?? undefined,
            color: color ?? undefined,
          },
        });

        // The backend returns the created bin ID in createdIds
        if (result.createdIds && result.createdIds.length > 0) {
          const newBinId = result.createdIds[0];
          // Start editing the new bin for inline rename
          startEditing(newBinId);
          return newBinId;
        }
        return null;
      } catch (error) {
        logger.error('Failed to create bin', { name, parentId, error });
        throw error;
      }
    },
    [executeCommand, startEditing],
  );

  /**
   * Deletes a bin and all its children from the backend.
   * Clears selection if the selected bin is the target or a descendant.
   */
  const deleteBin = useCallback(
    async (binId: string) => {
      try {
        const { selectedBinId, bins } = useBinStore.getState();

        await executeCommand({
          type: 'RemoveBin',
          payload: { binId },
        });

        // Clear selection only after successful deletion
        if (selectedBinId !== null && selectedBinId === binId) {
          selectBin(null);
        } else if (selectedBinId !== null) {
          const descendants = getBinDescendants(binId, Array.from(bins.values()));
          if (descendants.has(selectedBinId)) {
            selectBin(null);
          }
        }
      } catch (error) {
        logger.error('Failed to delete bin', { binId, error });
        throw error;
      }
    },
    [executeCommand, selectBin],
  );

  /**
   * Renames a bin.
   */
  const renameBin = useCallback(
    async (binId: string, newName: string) => {
      try {
        await executeCommand({
          type: 'RenameBin',
          payload: { binId, name: newName },
        });
      } catch (error) {
        logger.error('Failed to rename bin', { binId, newName, error });
        throw error;
      }
    },
    [executeCommand],
  );

  /**
   * Moves a bin to a new parent.
   */
  const moveBin = useCallback(
    async (binId: string, newParentId: string | null) => {
      try {
        await executeCommand({
          type: 'MoveBin',
          payload: {
            binId,
            parentId: newParentId ?? undefined,
          },
        });
      } catch (error) {
        logger.error('Failed to move bin', { binId, newParentId, error });
        throw error;
      }
    },
    [executeCommand],
  );

  /**
   * Sets the color of a bin.
   */
  const setBinColor = useCallback(
    async (binId: string, color: BinColor) => {
      try {
        await executeCommand({
          type: 'SetBinColor',
          payload: { binId, color },
        });
      } catch (error) {
        logger.error('Failed to set bin color', { binId, color, error });
        throw error;
      }
    },
    [executeCommand],
  );

  /**
   * Moves an asset to a bin.
   */
  const moveAssetToBin = useCallback(
    async (assetId: string, binId: string | null) => {
      try {
        await executeCommand({
          type: 'MoveAssetToBin',
          payload: {
            assetId,
            binId: binId ?? undefined,
          },
        });
      } catch (error) {
        logger.error('Failed to move asset to bin', { assetId, binId, error });
        throw error;
      }
    },
    [executeCommand],
  );

  return {
    createBin,
    deleteBin,
    renameBin,
    moveBin,
    setBinColor,
    moveAssetToBin,
  };
}

export default useBinOperations;
