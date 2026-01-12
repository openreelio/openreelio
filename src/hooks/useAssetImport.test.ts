/**
 * useAssetImport Hook Tests
 *
 * TDD: Tests for the asset import hook with file dialog integration
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAssetImport } from './useAssetImport';

// =============================================================================
// Mocks
// =============================================================================

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(),
}));

vi.mock('@/stores', () => ({
  useProjectStore: vi.fn(),
}));

import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { useProjectStore } from '@/stores';

const mockOpenDialog = openDialog as Mock;
const mockUseProjectStore = useProjectStore as unknown as Mock;

// =============================================================================
// Tests
// =============================================================================

describe('useAssetImport', () => {
  const mockImportAsset = vi.fn();
  const mockSelectAsset = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockUseProjectStore.mockReturnValue({
      importAsset: mockImportAsset,
      selectAsset: mockSelectAsset,
      isLoading: false,
    });
  });

  // ===========================================================================
  // Initial State Tests
  // ===========================================================================

  describe('initial state', () => {
    it('should return isImporting as false initially', () => {
      const { result } = renderHook(() => useAssetImport());

      expect(result.current.isImporting).toBe(false);
    });

    it('should return error as null initially', () => {
      const { result } = renderHook(() => useAssetImport());

      expect(result.current.error).toBeNull();
    });

    it('should return importedAssetIds as empty array initially', () => {
      const { result } = renderHook(() => useAssetImport());

      expect(result.current.importedAssetIds).toEqual([]);
    });
  });

  // ===========================================================================
  // Single File Import Tests
  // ===========================================================================

  describe('importFiles', () => {
    it('should open file dialog with correct filters', async () => {
      mockOpenDialog.mockResolvedValue(null);

      const { result } = renderHook(() => useAssetImport());

      await act(async () => {
        await result.current.importFiles();
      });

      expect(mockOpenDialog).toHaveBeenCalledWith({
        multiple: true,
        title: 'Import Media Files',
        filters: [
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
        ],
      });
    });

    it('should do nothing when dialog is cancelled', async () => {
      mockOpenDialog.mockResolvedValue(null);

      const { result } = renderHook(() => useAssetImport());

      await act(async () => {
        await result.current.importFiles();
      });

      expect(mockImportAsset).not.toHaveBeenCalled();
      expect(result.current.importedAssetIds).toEqual([]);
    });

    it('should import single file when selected', async () => {
      mockOpenDialog.mockResolvedValue('/path/to/video.mp4');
      mockImportAsset.mockResolvedValue('asset-123');

      const { result } = renderHook(() => useAssetImport());

      await act(async () => {
        await result.current.importFiles();
      });

      expect(mockImportAsset).toHaveBeenCalledWith('/path/to/video.mp4');
      expect(result.current.importedAssetIds).toEqual(['asset-123']);
    });

    it('should import multiple files when selected', async () => {
      mockOpenDialog.mockResolvedValue([
        '/path/to/video1.mp4',
        '/path/to/video2.mp4',
        '/path/to/audio.mp3',
      ]);
      mockImportAsset
        .mockResolvedValueOnce('asset-1')
        .mockResolvedValueOnce('asset-2')
        .mockResolvedValueOnce('asset-3');

      const { result } = renderHook(() => useAssetImport());

      await act(async () => {
        await result.current.importFiles();
      });

      expect(mockImportAsset).toHaveBeenCalledTimes(3);
      expect(result.current.importedAssetIds).toEqual(['asset-1', 'asset-2', 'asset-3']);
    });

    it('should set isImporting false after import completes', async () => {
      mockOpenDialog.mockResolvedValue('/path/to/video.mp4');
      mockImportAsset.mockResolvedValue('asset-123');

      const { result } = renderHook(() => useAssetImport());

      await act(async () => {
        await result.current.importFiles();
      });

      // After completion, isImporting should be false
      expect(result.current.isImporting).toBe(false);
      expect(result.current.importedAssetIds).toEqual(['asset-123']);
    });

    it('should select first imported asset after import', async () => {
      mockOpenDialog.mockResolvedValue(['/path/to/video1.mp4', '/path/to/video2.mp4']);
      mockImportAsset.mockResolvedValueOnce('asset-1').mockResolvedValueOnce('asset-2');

      const { result } = renderHook(() => useAssetImport());

      await act(async () => {
        await result.current.importFiles();
      });

      expect(mockSelectAsset).toHaveBeenCalledWith('asset-1');
    });
  });

  // ===========================================================================
  // Error Handling Tests
  // ===========================================================================

  describe('error handling', () => {
    it('should set error when single file import fails', async () => {
      mockOpenDialog.mockResolvedValue('/path/to/video.mp4');
      mockImportAsset.mockRejectedValue(new Error('Import failed'));

      const { result } = renderHook(() => useAssetImport());

      await act(async () => {
        await result.current.importFiles();
      });

      // Single file failure reports as "1 file(s) failed to import"
      expect(result.current.error).toBe('1 file(s) failed to import');
      expect(result.current.isImporting).toBe(false);
    });

    it('should clear error on new successful import attempt', async () => {
      mockOpenDialog.mockResolvedValue('/path/to/video.mp4');
      mockImportAsset.mockRejectedValueOnce(new Error('First import failed'));
      mockImportAsset.mockResolvedValueOnce('asset-123');

      const { result } = renderHook(() => useAssetImport());

      // First import - fails
      await act(async () => {
        await result.current.importFiles();
      });

      expect(result.current.error).toBe('1 file(s) failed to import');

      // Second import - succeeds
      await act(async () => {
        await result.current.importFiles();
      });

      expect(result.current.error).toBeNull();
    });

    it('should continue importing remaining files when one fails', async () => {
      mockOpenDialog.mockResolvedValue([
        '/path/to/video1.mp4',
        '/path/to/bad-file.mp4',
        '/path/to/video2.mp4',
      ]);
      mockImportAsset
        .mockResolvedValueOnce('asset-1')
        .mockRejectedValueOnce(new Error('Bad file'))
        .mockResolvedValueOnce('asset-3');

      const { result } = renderHook(() => useAssetImport());

      await act(async () => {
        await result.current.importFiles();
      });

      // Should have imported 2 out of 3
      expect(result.current.importedAssetIds).toEqual(['asset-1', 'asset-3']);
      expect(result.current.error).toBe('1 file(s) failed to import');
    });

    it('should handle dialog error gracefully', async () => {
      mockOpenDialog.mockRejectedValue(new Error('Dialog error'));

      const { result } = renderHook(() => useAssetImport());

      await act(async () => {
        await result.current.importFiles();
      });

      expect(result.current.error).toBe('Dialog error');
      expect(result.current.isImporting).toBe(false);
    });
  });

  // ===========================================================================
  // Clear Error Tests
  // ===========================================================================

  describe('clearError', () => {
    it('should clear error when clearError is called', async () => {
      mockOpenDialog.mockResolvedValue('/path/to/video.mp4');
      mockImportAsset.mockRejectedValue(new Error('Import failed'));

      const { result } = renderHook(() => useAssetImport());

      await act(async () => {
        await result.current.importFiles();
      });

      // Error is set from failed import
      expect(result.current.error).toBe('1 file(s) failed to import');

      act(() => {
        result.current.clearError();
      });

      expect(result.current.error).toBeNull();
    });
  });

  // ===========================================================================
  // Import URIs Tests
  // ===========================================================================

  describe('importFromUris', () => {
    it('should import files from given URIs', async () => {
      mockImportAsset
        .mockResolvedValueOnce('asset-1')
        .mockResolvedValueOnce('asset-2');

      const { result } = renderHook(() => useAssetImport());

      await act(async () => {
        await result.current.importFromUris(['/path/to/video1.mp4', '/path/to/video2.mp4']);
      });

      expect(mockImportAsset).toHaveBeenCalledTimes(2);
      expect(mockImportAsset).toHaveBeenCalledWith('/path/to/video1.mp4');
      expect(mockImportAsset).toHaveBeenCalledWith('/path/to/video2.mp4');
      expect(result.current.importedAssetIds).toEqual(['asset-1', 'asset-2']);
    });

    it('should do nothing when empty array is passed', async () => {
      const { result } = renderHook(() => useAssetImport());

      await act(async () => {
        await result.current.importFromUris([]);
      });

      expect(mockImportAsset).not.toHaveBeenCalled();
      expect(result.current.importedAssetIds).toEqual([]);
    });

    it('should set isImporting during uri import', async () => {
      let resolveImport: (value: string) => void;
      mockImportAsset.mockImplementation(
        () => new Promise<string>((resolve) => { resolveImport = resolve; })
      );

      const { result } = renderHook(() => useAssetImport());

      let importPromise: Promise<void>;
      act(() => {
        importPromise = result.current.importFromUris(['/path/to/video.mp4']);
      });

      expect(result.current.isImporting).toBe(true);

      await act(async () => {
        resolveImport!('asset-123');
        await importPromise;
      });

      expect(result.current.isImporting).toBe(false);
    });
  });

  // ===========================================================================
  // Reset State Tests
  // ===========================================================================

  describe('resetState', () => {
    it('should reset all state when resetState is called', async () => {
      mockOpenDialog.mockResolvedValue('/path/to/video.mp4');
      mockImportAsset.mockResolvedValue('asset-123');

      const { result } = renderHook(() => useAssetImport());

      // Import a file
      await act(async () => {
        await result.current.importFiles();
      });

      expect(result.current.importedAssetIds).toEqual(['asset-123']);

      // Reset
      act(() => {
        result.current.resetState();
      });

      expect(result.current.importedAssetIds).toEqual([]);
      expect(result.current.error).toBeNull();
      expect(result.current.isImporting).toBe(false);
    });
  });
});
