/**
 * useProject Hook Tests
 *
 * TDD: Tests for project management hook
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useProject } from './useProject';

// Mock the project store
const mockCreateProject = vi.fn();
const mockLoadProject = vi.fn();
const mockSaveProject = vi.fn();
const mockCloseProject = vi.fn();
const mockImportAsset = vi.fn();
const mockRemoveAsset = vi.fn();

vi.mock('@/stores', () => ({
  useProjectStore: vi.fn((selector) => {
    const state = {
      isLoaded: false,
      isLoading: false,
      isDirty: false,
      meta: null,
      assets: new Map(),
      sequences: new Map(),
      activeSequenceId: null,
      selectedAssetId: null,
      error: null,
      createProject: mockCreateProject,
      loadProject: mockLoadProject,
      saveProject: mockSaveProject,
      closeProject: mockCloseProject,
      importAsset: mockImportAsset,
      removeAsset: mockRemoveAsset,
      selectAsset: vi.fn(),
      getActiveSequence: vi.fn(),
    };
    return selector ? selector(state) : state;
  }),
}));

describe('useProject', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('state', () => {
    it('returns isLoaded state', () => {
      const { result } = renderHook(() => useProject());
      expect(result.current.isLoaded).toBe(false);
    });

    it('returns isLoading state', () => {
      const { result } = renderHook(() => useProject());
      expect(result.current.isLoading).toBe(false);
    });

    it('returns isDirty state', () => {
      const { result } = renderHook(() => useProject());
      expect(result.current.isDirty).toBe(false);
    });

    it('returns project meta', () => {
      const { result } = renderHook(() => useProject());
      expect(result.current.meta).toBeNull();
    });

    it('returns error state', () => {
      const { result } = renderHook(() => useProject());
      expect(result.current.error).toBeNull();
    });
  });

  describe('actions', () => {
    it('provides createProject action', async () => {
      const { result } = renderHook(() => useProject());

      await act(async () => {
        await result.current.createProject('Test', '/path');
      });

      expect(mockCreateProject).toHaveBeenCalledWith('Test', '/path');
    });

    it('provides loadProject action', async () => {
      const { result } = renderHook(() => useProject());

      await act(async () => {
        await result.current.loadProject('/path');
      });

      expect(mockLoadProject).toHaveBeenCalledWith('/path');
    });

    it('provides saveProject action', async () => {
      const { result } = renderHook(() => useProject());

      await act(async () => {
        await result.current.saveProject();
      });

      expect(mockSaveProject).toHaveBeenCalled();
    });

    it('provides closeProject action', async () => {
      const { result } = renderHook(() => useProject());

      await act(async () => {
        await result.current.closeProject();
      });

      expect(mockCloseProject).toHaveBeenCalled();
    });
  });

  describe('asset operations', () => {
    it('provides importAsset action', async () => {
      const { result } = renderHook(() => useProject());

      await act(async () => {
        await result.current.importAsset('/path/to/file.mp4');
      });

      expect(mockImportAsset).toHaveBeenCalledWith('/path/to/file.mp4');
    });

    it('provides removeAsset action', async () => {
      const { result } = renderHook(() => useProject());

      await act(async () => {
        await result.current.removeAsset('asset-123');
      });

      expect(mockRemoveAsset).toHaveBeenCalledWith('asset-123');
    });
  });

  describe('computed values', () => {
    it('returns hasProject as false when not loaded', () => {
      const { result } = renderHook(() => useProject());
      expect(result.current.hasProject).toBe(false);
    });

    it('returns projectName as undefined when no project', () => {
      const { result } = renderHook(() => useProject());
      expect(result.current.projectName).toBeUndefined();
    });

    it('returns assetCount as 0 when no assets', () => {
      const { result } = renderHook(() => useProject());
      expect(result.current.assetCount).toBe(0);
    });
  });
});
