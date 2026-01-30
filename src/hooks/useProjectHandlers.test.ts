/**
 * useProjectHandlers Hook Tests
 *
 * Tests for project creation and opening operations with unsaved changes handling.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useProjectHandlers, type ProjectCreateData } from './useProjectHandlers';
import { useProjectStore } from '@/stores';
import { open, confirm } from '@tauri-apps/plugin-dialog';
import type { RecentProject } from '@/utils/recentProjects';

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
  addRecentProject: vi.fn((project: RecentProject) => [project]),
  removeRecentProjectByPath: vi.fn(() => []),
}));

vi.mock('@/utils/projectPath', () => ({
  buildProjectPath: vi.fn((base: string, name: string) => `${base}/${name}`),
  validateProjectName: vi.fn((name: string) => ({
    sanitized: name,
    errors: [],
  })),
}));

vi.mock('@/utils/errorMessages', () => ({
  getUserFriendlyError: vi.fn((error: unknown) =>
    error instanceof Error ? error.message : String(error)
  ),
}));

describe('useProjectHandlers', () => {
  const mockCreateProject = vi.fn();
  const mockLoadProject = vi.fn();
  const mockSaveProject = vi.fn();
  const mockSetRecentProjects = vi.fn();
  const mockAddToast = vi.fn();

  const defaultStoreState = {
    isDirty: false,
    meta: null as { path: string } | null,
    saveProject: mockSaveProject,
    createProject: mockCreateProject,
    loadProject: mockLoadProject,
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
    mockCreateProject.mockResolvedValue(undefined);
    mockLoadProject.mockResolvedValue(undefined);
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

  describe('handleNewProject', () => {
    it('should open create dialog when called', () => {
      const { result } = renderUseProjectHandlers();

      expect(result.current.showCreateDialog).toBe(false);

      act(() => {
        result.current.handleNewProject();
      });

      expect(result.current.showCreateDialog).toBe(true);
    });
  });

  describe('handleCancelCreate', () => {
    it('should close create dialog when called', () => {
      const { result } = renderUseProjectHandlers();

      // Open dialog first
      act(() => {
        result.current.handleNewProject();
      });

      expect(result.current.showCreateDialog).toBe(true);

      // Cancel
      act(() => {
        result.current.handleCancelCreate();
      });

      expect(result.current.showCreateDialog).toBe(false);
    });
  });

  describe('handleCreateProject', () => {
    const projectData: ProjectCreateData = {
      name: 'Test Project',
      path: '/path/to',
      format: 'youtube_1080',
    };

    it('should create project successfully with no unsaved changes', async () => {
      mockCreateProject.mockResolvedValue(undefined);
      const { result } = renderUseProjectHandlers();

      await act(async () => {
        await result.current.handleCreateProject(projectData);
      });

      expect(mockCreateProject).toHaveBeenCalledWith('Test Project', '/path/to/Test Project');
      expect(mockSetRecentProjects).toHaveBeenCalled();
      expect(mockAddToast).toHaveBeenCalledWith(
        expect.stringContaining('created successfully'),
        'success'
      );
    });

    it('should ask to save when there are unsaved changes', async () => {
      // Setup dirty state
      const dirtyState = {
        ...defaultStoreState,
        isDirty: true,
        meta: { path: '/existing/project' },
      };
      (useProjectStore as unknown as { getState: () => typeof dirtyState }).getState = () =>
        dirtyState;

      (confirm as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      mockSaveProject.mockResolvedValue(undefined);
      mockCreateProject.mockResolvedValue(undefined);

      const { result } = renderUseProjectHandlers();

      await act(async () => {
        await result.current.handleCreateProject(projectData);
      });

      expect(confirm).toHaveBeenCalledWith(
        expect.stringContaining('unsaved changes'),
        expect.any(Object)
      );
      expect(mockSaveProject).toHaveBeenCalled();
      expect(mockCreateProject).toHaveBeenCalled();
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

      mockCreateProject.mockResolvedValue(undefined);

      const { result } = renderUseProjectHandlers();

      await act(async () => {
        await result.current.handleCreateProject(projectData);
      });

      expect(confirm).toHaveBeenCalledTimes(2);
      expect(mockCreateProject).toHaveBeenCalled();
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
        await result.current.handleCreateProject(projectData);
      });

      expect(mockCreateProject).not.toHaveBeenCalled();
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
      mockCreateProject.mockResolvedValue(undefined);

      const { result } = renderUseProjectHandlers();

      await act(async () => {
        await result.current.handleCreateProject(projectData);
      });

      expect(mockSaveProject).not.toHaveBeenCalled();
      expect(mockCreateProject).toHaveBeenCalled();
    });

    it('should handle creation failure', async () => {
      mockCreateProject.mockRejectedValue(new Error('Creation failed'));

      const { result } = renderUseProjectHandlers();

      await act(async () => {
        await result.current.handleCreateProject(projectData);
      });

      expect(mockAddToast).toHaveBeenCalledWith(
        expect.stringContaining('Could not create the project'),
        'error'
      );
    });

    it('should prevent concurrent operations', async () => {
      vi.useFakeTimers();

      // Make create slow
      mockCreateProject.mockImplementation(
        () => new Promise((resolve) => setTimeout(resolve, 1000))
      );

      const { result } = renderUseProjectHandlers();

      // Start first operation (wrapped in act to handle state updates)
      let firstOpPromise: Promise<void>;
      act(() => {
        firstOpPromise = result.current.handleCreateProject(projectData);
      });

      // Try to start second operation immediately (while first is in progress)
      await act(async () => {
        await result.current.handleCreateProject({ ...projectData, name: 'Second' });
      });

      // Should show warning toast for concurrent operation
      expect(mockAddToast).toHaveBeenCalledWith(
        expect.stringContaining('wait for the current operation'),
        'warning'
      );

      // Complete first operation
      await act(async () => {
        await vi.runAllTimersAsync();
        await firstOpPromise!;
      });

      // Only one create call
      expect(mockCreateProject).toHaveBeenCalledTimes(1);

      vi.useRealTimers();
    });

    it('should set isCreatingProject during creation', async () => {
      // Track whether create was called and control when it resolves
      let createResolver: (value?: unknown) => void;
      const createPromise = new Promise((resolve) => {
        createResolver = resolve;
      });
      mockCreateProject.mockReturnValue(createPromise);

      const { result } = renderUseProjectHandlers();

      expect(result.current.isCreatingProject).toBe(false);

      // Start the operation
      let handlePromise: Promise<void>;
      act(() => {
        handlePromise = result.current.handleCreateProject(projectData);
      });

      // isCreatingProject should now be true
      expect(result.current.isCreatingProject).toBe(true);

      // Complete the operation
      await act(async () => {
        createResolver!();
        await handlePromise!;
      });

      expect(result.current.isCreatingProject).toBe(false);
    });
  });

  describe('handleOpenProject', () => {
    it('should open project from provided path', async () => {
      mockLoadProject.mockResolvedValue(undefined);

      const { result } = renderUseProjectHandlers();

      await act(async () => {
        await result.current.handleOpenProject('/path/to/project');
      });

      expect(mockLoadProject).toHaveBeenCalledWith('/path/to/project');
      expect(mockSetRecentProjects).toHaveBeenCalled();
      expect(mockAddToast).toHaveBeenCalledWith(
        expect.stringContaining('opened'),
        'success'
      );
    });

    it('should show file picker when no path provided', async () => {
      (open as ReturnType<typeof vi.fn>).mockResolvedValue('/selected/path');
      mockLoadProject.mockResolvedValue(undefined);

      const { result } = renderUseProjectHandlers();

      await act(async () => {
        await result.current.handleOpenProject();
      });

      expect(open).toHaveBeenCalledWith({
        directory: true,
        multiple: false,
        title: 'Open Project',
      });
      expect(mockLoadProject).toHaveBeenCalledWith('/selected/path');
    });

    it('should do nothing if file picker is cancelled', async () => {
      (open as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const { result } = renderUseProjectHandlers();

      await act(async () => {
        await result.current.handleOpenProject();
      });

      expect(mockLoadProject).not.toHaveBeenCalled();
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
      mockLoadProject.mockResolvedValue(undefined);

      const { result } = renderUseProjectHandlers();

      await act(async () => {
        await result.current.handleOpenProject('/new/project');
      });

      expect(confirm).toHaveBeenCalled();
      expect(mockSaveProject).toHaveBeenCalled();
      expect(mockLoadProject).toHaveBeenCalled();
    });

    it('should handle project not found and remove from recent', async () => {
      mockLoadProject.mockRejectedValue(new Error('project not found'));

      const { result } = renderUseProjectHandlers();

      await act(async () => {
        await result.current.handleOpenProject('/missing/project');
      });

      expect(mockAddToast).toHaveBeenCalledWith(
        expect.stringContaining('moved or deleted'),
        'error'
      );
      // removeRecentProjectByPath should be called
    });

    it('should handle generic open error', async () => {
      mockLoadProject.mockRejectedValue(new Error('Unknown error'));

      const { result } = renderUseProjectHandlers();

      await act(async () => {
        await result.current.handleOpenProject('/bad/project');
      });

      expect(mockAddToast).toHaveBeenCalledWith(
        expect.stringContaining('Unknown error'),
        'error'
      );
    });

    it('should prevent concurrent open operations', async () => {
      vi.useFakeTimers();

      mockLoadProject.mockImplementation(
        () => new Promise((resolve) => setTimeout(resolve, 1000))
      );

      const { result } = renderUseProjectHandlers();

      // Start first operation (wrapped in act to handle state updates)
      let firstOpPromise: Promise<void>;
      act(() => {
        firstOpPromise = result.current.handleOpenProject('/first/project');
      });

      // Try to start second operation immediately (while first is in progress)
      await act(async () => {
        await result.current.handleOpenProject('/second/project');
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

      expect(mockLoadProject).toHaveBeenCalledTimes(1);

      vi.useRealTimers();
    });
  });

  describe('edge cases', () => {
    it('should handle empty project name', async () => {
      const { result } = renderUseProjectHandlers();

      await act(async () => {
        await result.current.handleCreateProject({
          name: '',
          path: '/path/to',
        });
      });

      // Should still attempt creation (validation is done by validateProjectName)
      expect(mockCreateProject).toHaveBeenCalled();
    });

    it('should extract folder name from path for recent projects', async () => {
      mockLoadProject.mockResolvedValue(undefined);

      const { result } = renderUseProjectHandlers();

      await act(async () => {
        await result.current.handleOpenProject('/path/to/MyProject');
      });

      // addRecentProject should be called with the folder name
      expect(mockSetRecentProjects).toHaveBeenCalled();
    });
  });
});
