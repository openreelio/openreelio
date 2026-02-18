/**
 * useBinOperations Hook Tests
 *
 * Tests for bin CRUD operations that persist to the backend.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useBinOperations } from './useBinOperations';
import { getBinDescendants } from '@/utils/binUtils';

// =============================================================================
// Mocks
// =============================================================================

const mockExecuteCommand = vi.fn();
const mockSelectBin = vi.fn();
const mockStartEditing = vi.fn();

vi.mock('@/stores/projectStore', () => ({
  useProjectStore: (selector: (state: Record<string, unknown>) => unknown) => {
    const state = { executeCommand: mockExecuteCommand };
    return selector(state);
  },
}));

let mockSelectedBinId: string | null = null;
const mockBins = new Map<string, { id: string; name: string; parentId: string | null }>();

vi.mock('@/stores/binStore', () => ({
  useBinStore: Object.assign(
    (selector?: (state: Record<string, unknown>) => unknown) => {
      const state = {
        selectBin: mockSelectBin,
        startEditing: mockStartEditing,
        selectedBinId: mockSelectedBinId,
        bins: mockBins,
      };
      if (typeof selector === 'function') {
        return selector(state);
      }
      return state;
    },
    {
      getState: () => ({
        selectedBinId: mockSelectedBinId,
        bins: mockBins,
      }),
    },
  ),
}));

vi.mock('@/utils/binUtils', () => ({
  getBinDescendants: vi.fn().mockReturnValue(new Set()),
}));

vi.mock('@/services/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// =============================================================================
// Tests
// =============================================================================

const mockGetBinDescendants = vi.mocked(getBinDescendants);

describe('useBinOperations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSelectedBinId = null;
    mockBins.clear();
    mockGetBinDescendants.mockReturnValue(new Set());
  });

  // ===========================================================================
  // createBin Tests
  // ===========================================================================

  describe('createBin', () => {
    it('should execute CreateBin command', async () => {
      mockExecuteCommand.mockResolvedValue({ createdIds: ['new-bin-123'] });

      const { result } = renderHook(() => useBinOperations());

      await act(async () => {
        await result.current.createBin('My Folder', null);
      });

      expect(mockExecuteCommand).toHaveBeenCalledWith({
        type: 'CreateBin',
        payload: { name: 'My Folder', parentId: undefined, color: undefined },
      });
    });

    it('should start editing the new bin', async () => {
      mockExecuteCommand.mockResolvedValue({ createdIds: ['new-bin-123'] });

      const { result } = renderHook(() => useBinOperations());

      await act(async () => {
        await result.current.createBin('My Folder', null);
      });

      expect(mockStartEditing).toHaveBeenCalledWith('new-bin-123');
    });

    it('should return the new bin ID', async () => {
      mockExecuteCommand.mockResolvedValue({ createdIds: ['new-bin-123'] });

      const { result } = renderHook(() => useBinOperations());

      let binId: string | null = null;
      await act(async () => {
        binId = await result.current.createBin('My Folder', null);
      });

      expect(binId).toBe('new-bin-123');
    });

    it('should pass parentId when creating a nested bin', async () => {
      mockExecuteCommand.mockResolvedValue({ createdIds: ['new-bin-456'] });

      const { result } = renderHook(() => useBinOperations());

      await act(async () => {
        await result.current.createBin('Subfolder', 'parent-bin-id');
      });

      expect(mockExecuteCommand).toHaveBeenCalledWith({
        type: 'CreateBin',
        payload: { name: 'Subfolder', parentId: 'parent-bin-id', color: undefined },
      });
    });

    it('should return null when createdIds is empty', async () => {
      mockExecuteCommand.mockResolvedValue({ createdIds: [] });

      const { result } = renderHook(() => useBinOperations());

      let binId: string | null = null;
      await act(async () => {
        binId = await result.current.createBin('My Folder', null);
      });

      expect(binId).toBeNull();
      expect(mockStartEditing).not.toHaveBeenCalled();
    });

    it('should return null when result has no createdIds', async () => {
      mockExecuteCommand.mockResolvedValue({});

      const { result } = renderHook(() => useBinOperations());

      let binId: string | null = null;
      await act(async () => {
        binId = await result.current.createBin('My Folder', null);
      });

      expect(binId).toBeNull();
    });

    it('should pass color when provided', async () => {
      mockExecuteCommand.mockResolvedValue({ createdIds: ['new-bin'] });

      const { result } = renderHook(() => useBinOperations());

      await act(async () => {
        await result.current.createBin('Colored Folder', null, 'blue');
      });

      expect(mockExecuteCommand).toHaveBeenCalledWith({
        type: 'CreateBin',
        payload: { name: 'Colored Folder', parentId: undefined, color: 'blue' },
      });
    });

    it('should throw on error', async () => {
      const error = new Error('Command failed');
      mockExecuteCommand.mockRejectedValue(error);

      const { result } = renderHook(() => useBinOperations());

      await expect(
        act(async () => {
          await result.current.createBin('My Folder', null);
        }),
      ).rejects.toThrow('Command failed');
    });
  });

  // ===========================================================================
  // deleteBin Tests
  // ===========================================================================

  describe('deleteBin', () => {
    it('should execute RemoveBin command', async () => {
      mockExecuteCommand.mockResolvedValue({});

      const { result } = renderHook(() => useBinOperations());

      await act(async () => {
        await result.current.deleteBin('bin-123');
      });

      expect(mockExecuteCommand).toHaveBeenCalledWith({
        type: 'RemoveBin',
        payload: { binId: 'bin-123' },
      });
    });

    it('should deselect when deleting the selected bin', async () => {
      mockSelectedBinId = 'bin-123';
      mockExecuteCommand.mockResolvedValue({});

      const { result } = renderHook(() => useBinOperations());

      await act(async () => {
        await result.current.deleteBin('bin-123');
      });

      expect(mockSelectBin).toHaveBeenCalledWith(null);
    });

    it('should deselect when deleting a parent of the selected bin', async () => {
      mockSelectedBinId = 'child-bin';
      mockBins.set('parent-bin', { id: 'parent-bin', name: 'Parent', parentId: null });
      mockBins.set('child-bin', { id: 'child-bin', name: 'Child', parentId: 'parent-bin' });
      mockGetBinDescendants.mockReturnValue(new Set(['child-bin']));
      mockExecuteCommand.mockResolvedValue({});

      const { result } = renderHook(() => useBinOperations());

      await act(async () => {
        await result.current.deleteBin('parent-bin');
      });

      expect(mockSelectBin).toHaveBeenCalledWith(null);
    });

    it('should not deselect when deleting an unrelated bin', async () => {
      mockSelectedBinId = 'other-bin';
      mockBins.set('bin-123', { id: 'bin-123', name: 'Target', parentId: null });
      mockBins.set('other-bin', { id: 'other-bin', name: 'Other', parentId: null });
      mockGetBinDescendants.mockReturnValue(new Set());
      mockExecuteCommand.mockResolvedValue({});

      const { result } = renderHook(() => useBinOperations());

      await act(async () => {
        await result.current.deleteBin('bin-123');
      });

      expect(mockSelectBin).not.toHaveBeenCalled();
    });

    it('should throw on error', async () => {
      const error = new Error('Delete failed');
      mockExecuteCommand.mockRejectedValue(error);

      const { result } = renderHook(() => useBinOperations());

      await expect(
        act(async () => {
          await result.current.deleteBin('bin-123');
        }),
      ).rejects.toThrow('Delete failed');
    });
  });

  // ===========================================================================
  // renameBin Tests
  // ===========================================================================

  describe('renameBin', () => {
    it('should execute RenameBin command', async () => {
      mockExecuteCommand.mockResolvedValue({});

      const { result } = renderHook(() => useBinOperations());

      await act(async () => {
        await result.current.renameBin('bin-123', 'New Name');
      });

      expect(mockExecuteCommand).toHaveBeenCalledWith({
        type: 'RenameBin',
        payload: { binId: 'bin-123', name: 'New Name' },
      });
    });

    it('should throw on error', async () => {
      const error = new Error('Rename failed');
      mockExecuteCommand.mockRejectedValue(error);

      const { result } = renderHook(() => useBinOperations());

      await expect(
        act(async () => {
          await result.current.renameBin('bin-123', 'New Name');
        }),
      ).rejects.toThrow('Rename failed');
    });
  });

  // ===========================================================================
  // moveBin Tests
  // ===========================================================================

  describe('moveBin', () => {
    it('should execute MoveBin command', async () => {
      mockExecuteCommand.mockResolvedValue({});

      const { result } = renderHook(() => useBinOperations());

      await act(async () => {
        await result.current.moveBin('bin-123', 'parent-456');
      });

      expect(mockExecuteCommand).toHaveBeenCalledWith({
        type: 'MoveBin',
        payload: { binId: 'bin-123', parentId: 'parent-456' },
      });
    });

    it('should pass undefined parentId when moving to root', async () => {
      mockExecuteCommand.mockResolvedValue({});

      const { result } = renderHook(() => useBinOperations());

      await act(async () => {
        await result.current.moveBin('bin-123', null);
      });

      expect(mockExecuteCommand).toHaveBeenCalledWith({
        type: 'MoveBin',
        payload: { binId: 'bin-123', parentId: undefined },
      });
    });

    it('should throw on error', async () => {
      const error = new Error('Move failed');
      mockExecuteCommand.mockRejectedValue(error);

      const { result } = renderHook(() => useBinOperations());

      await expect(
        act(async () => {
          await result.current.moveBin('bin-123', 'parent-456');
        }),
      ).rejects.toThrow('Move failed');
    });
  });

  // ===========================================================================
  // setBinColor Tests
  // ===========================================================================

  describe('setBinColor', () => {
    it('should execute SetBinColor command', async () => {
      mockExecuteCommand.mockResolvedValue({});

      const { result } = renderHook(() => useBinOperations());

      await act(async () => {
        await result.current.setBinColor('bin-123', 'blue');
      });

      expect(mockExecuteCommand).toHaveBeenCalledWith({
        type: 'SetBinColor',
        payload: { binId: 'bin-123', color: 'blue' },
      });
    });

    it('should throw on error', async () => {
      const error = new Error('Color failed');
      mockExecuteCommand.mockRejectedValue(error);

      const { result } = renderHook(() => useBinOperations());

      await expect(
        act(async () => {
          await result.current.setBinColor('bin-123', 'red');
        }),
      ).rejects.toThrow('Color failed');
    });
  });

  // ===========================================================================
  // moveAssetToBin Tests
  // ===========================================================================

  describe('moveAssetToBin', () => {
    it('should execute MoveAssetToBin command', async () => {
      mockExecuteCommand.mockResolvedValue({});

      const { result } = renderHook(() => useBinOperations());

      await act(async () => {
        await result.current.moveAssetToBin('asset-123', 'bin-456');
      });

      expect(mockExecuteCommand).toHaveBeenCalledWith({
        type: 'MoveAssetToBin',
        payload: { assetId: 'asset-123', binId: 'bin-456' },
      });
    });

    it('should pass undefined binId when moving to root', async () => {
      mockExecuteCommand.mockResolvedValue({});

      const { result } = renderHook(() => useBinOperations());

      await act(async () => {
        await result.current.moveAssetToBin('asset-123', null);
      });

      expect(mockExecuteCommand).toHaveBeenCalledWith({
        type: 'MoveAssetToBin',
        payload: { assetId: 'asset-123', binId: undefined },
      });
    });

    it('should throw on error', async () => {
      const error = new Error('Move asset failed');
      mockExecuteCommand.mockRejectedValue(error);

      const { result } = renderHook(() => useBinOperations());

      await expect(
        act(async () => {
          await result.current.moveAssetToBin('asset-123', 'bin-456');
        }),
      ).rejects.toThrow('Move asset failed');
    });
  });
});
