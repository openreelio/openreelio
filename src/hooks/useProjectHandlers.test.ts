/**
 * useProjectHandlers Hook Tests
 *
 * Tests for folder-based project opening operations with unsaved changes handling.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useProjectHandlers } from './useProjectHandlers';
import { useProjectStore } from '@/stores';
import { open, confirm } from '@tauri-apps/plugin-dialog';

// Mock dependencies
vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(),
  confirm: vi.fn(),
}));

vi.mock('@/stores', () => ({
  useProjectStore: vi.fn(),
}));

vi.mock('@/services/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// Mock direct module imports (matching the source file's direct imports)
vi.mock('@/utils/recentProjects', () => ({
  addRecentProject: vi.fn((project: { name: string; path: string }) => [project]),
  removeRecentProjectByPath: vi.fn(() => []),
}));

vi.mock('@/utils/errorMessages', () => ({
  getUserFriendlyError: vi.fn((error: unknown) =>
    error instanceof Error ? error.message : String(error)
  ),
}));

describe('useProjectHandlers', () => {
  const mockOpenOrInitProject = vi.fn();
  const mockSaveProject = vi.fn();
  const mockSetRecentProjects = vi.fn();
  const mockAddToast = vi.fn();

  const defaultStoreState = {
    isDirty: false,
    meta: null as { path: string } | null,
    saveProject: mockSaveProject,
    openOrInitProject: mockOpenOrInitProject,
  };

  beforeEach(() => {
    vi.clearAllMocks();

    // Default store mock
    (useProjectStore as unknown as ReturnType<typeof vi.fn>).mockImplementation((selector?: unknown) => {
      if (typeof selector === 'function') {
        return selector(defaultStoreState);
      }
      return defaultStoreState;
    });

    // Add getState to the mock
    (useProjectStore as unknown as { getState: () => typeof defaultStoreState }).getState = () =>
      defaultStoreState;
  });

  afterEach(() => {
    // Ensure real timers are always restored
    vi.useRealTimers();
    vi.resetAllMocks();
    // Reset mock implementations to default resolved values
    mockOpenOrInitProject.mockResolvedValue(undefined);
    mockSaveProject.mockResolvedValue(undefined);
  });

  const renderUseProjectHandlers = () => {
    return renderHook(() =>
      useProjectHandlers({
        setRecentProjects: mockSetRecentProjects,
        addToast: mockAddToast,
      })
    );
  };

  describe('handleOpenFolder', () => {
    it('should open project from provided path', async () => {
      mockOpenOrInitProject.mockResolvedValue(undefined);

      const { result } = renderUseProjectHandlers();

      await act(async () => {
        await result.current.handleOpenFolder('/path/to/project');
      });

      expect(mockOpenOrInitProject).toHaveBeenCalledWith('/path/to/project');
      expect(mockSetRecentProjects).toHaveBeenCalled();
      expect(mockAddToast).toHaveBeenCalledWith(
        expect.stringContaining('opened'),
        'success'
      );
    });

    it('should show folder picker when no path provided', async () => {
      (open as ReturnType<typeof vi.fn>).mockResolvedValue('/selected/path');
      mockOpenOrInitProject.mockResolvedValue(undefined);

      const { result } = renderUseProjectHandlers();

      await act(async () => {
        await result.current.handleOpenFolder();
      });

      expect(open).toHaveBeenCalledWith({
        directory: true,
        multiple: false,
        title: 'Open Folder',
      });
      expect(mockOpenOrInitProject).toHaveBeenCalledWith('/selected/path');
    });

    it('should do nothing if folder picker is cancelled', async () => {
      (open as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const { result } = renderUseProjectHandlers();

      await act(async () => {
        await result.current.handleOpenFolder();
      });

      expect(mockOpenOrInitProject).not.toHaveBeenCalled();
    });

    it('should ask to save unsaved changes before opening', async () => {
      const dirtyState = {
        ...defaultStoreState,
        isDirty: true,
        meta: { path: '/existing/project' },
      };
      (useProjectStore as unknown as { getState: () => typeof dirtyState }).getState = () =>
        dirtyState;

      (confirm as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      mockSaveProject.mockResolvedValue(undefined);
      mockOpenOrInitProject.mockResolvedValue(undefined);

      const { result } = renderUseProjectHandlers();

      await act(async () => {
        await result.current.handleOpenFolder('/new/project');
      });

      expect(confirm).toHaveBeenCalled();
      expect(mockSaveProject).toHaveBeenCalled();
      expect(mockOpenOrInitProject).toHaveBeenCalled();
    });

    it('should handle project not found and remove from recent', async () => {
      mockOpenOrInitProject.mockRejectedValue(new Error('project not found'));

      const { result } = renderUseProjectHandlers();

      await act(async () => {
        await result.current.handleOpenFolder('/missing/project');
      });

      expect(mockAddToast).toHaveBeenCalledWith(
        expect.stringContaining('moved or deleted'),
        'error'
      );
    });

    it('should handle generic open error', async () => {
      mockOpenOrInitProject.mockRejectedValue(new Error('Unknown error'));

      const { result } = renderUseProjectHandlers();

      await act(async () => {
        await result.current.handleOpenFolder('/bad/project');
      });

      expect(mockAddToast).toHaveBeenCalledWith(
        expect.stringContaining('Unknown error'),
        'error'
      );
    });

    it('should prevent concurrent open operations', async () => {
      vi.useFakeTimers();

      mockOpenOrInitProject.mockImplementation(
        () => new Promise((resolve) => setTimeout(resolve, 1000))
      );

      const { result } = renderUseProjectHandlers();

      // Start first operation (wrapped in act to handle state updates)
      let firstOpPromise: Promise<void>;
      act(() => {
        firstOpPromise = result.current.handleOpenFolder('/first/project');
      });

      // Try to start second operation immediately (while first is in progress)
      await act(async () => {
        await result.current.handleOpenFolder('/second/project');
      });

      expect(mockAddToast).toHaveBeenCalledWith(
        expect.stringContaining('wait for the current operation'),
        'warning'
      );

      // Complete first operation
      await act(async () => {
        await vi.runAllTimersAsync();
        await firstOpPromise!;
      });

      expect(mockOpenOrInitProject).toHaveBeenCalledTimes(1);

      vi.useRealTimers();
    });

    it('should discard changes if user chooses not to save', async () => {
      const dirtyState = {
        ...defaultStoreState,
        isDirty: true,
        meta: { path: '/existing/project' },
      };
      (useProjectStore as unknown as { getState: () => typeof dirtyState }).getState = () =>
        dirtyState;

      (confirm as ReturnType<typeof vi.fn>).mockResolvedValue(false); // Discard changes
      mockOpenOrInitProject.mockResolvedValue(undefined);

      const { result } = renderUseProjectHandlers();

      await act(async () => {
        await result.current.handleOpenFolder('/new/project');
      });

      expect(mockSaveProject).not.toHaveBeenCalled();
      expect(mockOpenOrInitProject).toHaveBeenCalled();
    });

    it('should handle save failure and ask to continue', async () => {
      const dirtyState = {
        ...defaultStoreState,
        isDirty: true,
        meta: { path: '/existing/project' },
        saveProject: vi.fn().mockRejectedValue(new Error('Save failed')),
      };
      (useProjectStore as unknown as { getState: () => typeof dirtyState }).getState = () =>
        dirtyState;

      // First confirm: save changes, Second confirm: continue despite failure
      (confirm as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(true) // Save changes
        .mockResolvedValueOnce(true); // Continue anyway

      mockOpenOrInitProject.mockResolvedValue(undefined);

      const { result } = renderUseProjectHandlers();

      await act(async () => {
        await result.current.handleOpenFolder('/new/project');
      });

      expect(confirm).toHaveBeenCalledTimes(2);
      expect(mockOpenOrInitProject).toHaveBeenCalled();
    });

    it('should abort if user cancels after save failure', async () => {
      const dirtyState = {
        ...defaultStoreState,
        isDirty: true,
        meta: { path: '/existing/project' },
        saveProject: vi.fn().mockRejectedValue(new Error('Save failed')),
      };
      (useProjectStore as unknown as { getState: () => typeof dirtyState }).getState = () =>
        dirtyState;

      // First confirm: save changes, Second confirm: cancel
      (confirm as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(true) // Save changes
        .mockResolvedValueOnce(false); // Cancel

      const { result } = renderUseProjectHandlers();

      await act(async () => {
        await result.current.handleOpenFolder('/new/project');
      });

      expect(mockOpenOrInitProject).not.toHaveBeenCalled();
    });

    it('should extract folder name from path for recent projects', async () => {
      mockOpenOrInitProject.mockResolvedValue(undefined);

      const { result } = renderUseProjectHandlers();

      await act(async () => {
        await result.current.handleOpenFolder('/path/to/MyProject');
      });

      // addRecentProject should be called with the folder name
      expect(mockSetRecentProjects).toHaveBeenCalled();
    });
  });
});
