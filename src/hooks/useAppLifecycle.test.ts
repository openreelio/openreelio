/**
 * useAppLifecycle Hook Tests
 *
 * Tests for application lifecycle events including window close handling,
 * unsaved changes protection, and backend cleanup.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAppLifecycle } from './useAppLifecycle';
import { isTauri } from '@tauri-apps/api/core';

// Mock Tauri APIs
const mockOnCloseRequested = vi.fn();
const mockClose = vi.fn();
const mockDestroy = vi.fn();
const mockConfirm = vi.fn();
const mockInvoke = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  isTauri: vi.fn(() => true),
  invoke: vi.fn((...args) => mockInvoke(...args)),
}));

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: vi.fn(() => ({
    onCloseRequested: mockOnCloseRequested,
    close: mockClose,
    destroy: mockDestroy,
  })),
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  confirm: vi.fn(() => mockConfirm()),
}));

vi.mock('@/services/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// Store mock state
let mockStoreState = {
  isDirty: false,
  meta: null as { path: string } | null,
  saveProject: vi.fn(),
};

let mockSettingsState = {
  flushPendingUpdates: vi.fn(),
};

vi.mock('@/stores', () => ({
  useProjectStore: {
    getState: () => mockStoreState,
  },
  useSettingsStore: {
    getState: () => mockSettingsState,
  },
  usePlaybackStore: (selector: (state: unknown) => unknown) => {
    const state = { currentTime: 0, isPlaying: false };
    return selector(state);
  },
}));

describe('useAppLifecycle', () => {
  let unlistenFn: () => void;
  let closeRequestedCallback: ((event: { preventDefault: () => void }) => Promise<void>) | null;
  const isTauriMock = vi.mocked(isTauri);

  beforeEach(() => {
    vi.clearAllMocks();
    isTauriMock.mockReturnValue(true);

    // Reset all mock implementations
    mockInvoke.mockReset();
    mockOnCloseRequested.mockReset();
    mockClose.mockReset();
    mockDestroy.mockReset();
    mockConfirm.mockReset();

    // Reset store state
    mockStoreState = {
      isDirty: false,
      meta: null,
      saveProject: vi.fn().mockResolvedValue(undefined),
    };

    mockSettingsState = {
      flushPendingUpdates: vi.fn().mockResolvedValue(undefined),
    };

    // Default cleanup result
    mockInvoke.mockResolvedValue({
      projectSaved: false,
      workersShutdown: true,
      error: null,
    });

    // Setup close handler mock
    unlistenFn = vi.fn();
    closeRequestedCallback = null;

    mockOnCloseRequested.mockImplementation((callback) => {
      closeRequestedCallback = callback;
      return Promise.resolve(unlistenFn);
    });

    // Make sure close is properly mocked
    mockClose.mockImplementation(() => Promise.resolve());
    mockDestroy.mockImplementation(() => Promise.resolve());
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('should setup close handler on mount', async () => {
    const { unmount } = renderHook(() => useAppLifecycle());

    // Wait for async setup
    await vi.waitFor(() => {
      expect(mockOnCloseRequested).toHaveBeenCalled();
    });

    unmount();
    expect(unlistenFn).toHaveBeenCalled();
  });

  it('should register beforeunload handler', () => {
    // Browser environment: isTauri() is false
    isTauriMock.mockReturnValue(false);

    const addEventListenerSpy = vi.spyOn(window, 'addEventListener');
    const removeEventListenerSpy = vi.spyOn(window, 'removeEventListener');

    const { unmount } = renderHook(() => useAppLifecycle());

    expect(addEventListenerSpy).toHaveBeenCalledWith('beforeunload', expect.any(Function));

    unmount();

    expect(removeEventListenerSpy).toHaveBeenCalledWith('beforeunload', expect.any(Function));

    addEventListenerSpy.mockRestore();
    removeEventListenerSpy.mockRestore();
  });

  it('should not register beforeunload handler in Tauri runtime', () => {
    // Tauri runtime: isTauri() is true
    isTauriMock.mockReturnValue(true);

    const addEventListenerSpy = vi.spyOn(window, 'addEventListener');

    renderHook(() => useAppLifecycle());

    const calls = addEventListenerSpy.mock.calls.filter((call) => call[0] === 'beforeunload');
    expect(calls).toHaveLength(0);

    addEventListenerSpy.mockRestore();
  });

  describe('close handler with no unsaved changes', () => {
    it('should prevent default, run cleanup, and explicitly destroy the window', async () => {
      renderHook(() => useAppLifecycle());

      await vi.waitFor(() => {
        expect(closeRequestedCallback).not.toBeNull();
      });

      const mockEvent = { preventDefault: vi.fn() };
      await act(async () => {
        await closeRequestedCallback!(mockEvent);
      });

      expect(mockEvent.preventDefault).toHaveBeenCalled();
      expect(mockInvoke).toHaveBeenCalledWith('app_cleanup');
      expect(mockSettingsState.flushPendingUpdates).toHaveBeenCalled();
      // We must not call close() from inside the close handler (can deadlock).
      expect(mockClose).not.toHaveBeenCalled();
      expect(mockDestroy).toHaveBeenCalled();
    });

    it('should fall back to forced destroy if explicit destroy fails', async () => {
      vi.useFakeTimers();

      mockDestroy.mockRejectedValue(new Error('destroy failed'));

      renderHook(() => useAppLifecycle());

      await vi.waitFor(() => {
        expect(closeRequestedCallback).not.toBeNull();
      });

      const mockEvent = { preventDefault: vi.fn() };
      await act(async () => {
        await closeRequestedCallback!(mockEvent);
      });

      expect(mockEvent.preventDefault).toHaveBeenCalled();
      expect(mockDestroy).toHaveBeenCalledTimes(1);

      // Force-close deadline should trigger another destroy attempt.
      await vi.advanceTimersByTimeAsync(15000);
      expect(mockDestroy).toHaveBeenCalledTimes(2);

      vi.useRealTimers();
    });

    it('should not block closing indefinitely if settings flush hangs', async () => {
      vi.useFakeTimers();

      // Simulate a settings flush that never resolves.
      mockSettingsState = {
        flushPendingUpdates: vi.fn(() => new Promise<void>(() => {})),
      };

      renderHook(() => useAppLifecycle());

      await vi.waitFor(() => {
        expect(closeRequestedCallback).not.toBeNull();
      });

      const mockEvent = { preventDefault: vi.fn() };
      const closePromise = closeRequestedCallback!(mockEvent);

      // Advance time beyond the settings flush timeout (3s in the hook).
      await vi.advanceTimersByTimeAsync(3500);
      await act(async () => {
        await closePromise;
      });

      expect(mockEvent.preventDefault).toHaveBeenCalled();
      expect(mockClose).not.toHaveBeenCalled();
      expect(mockDestroy).toHaveBeenCalled();

      vi.useRealTimers();
    });

    it('should ignore duplicate close requests during cleanup but keep the window open until cleanup completes', async () => {
      // Create a deferred cleanup promise so we can send a second close request mid-cleanup.
      type CleanupResult = { projectSaved: boolean; workersShutdown: boolean; error: string | null };

      let resolveCleanup: (value: CleanupResult) => void = () => {
        throw new Error('resolveCleanup not initialized');
      };
      const cleanupPromise = new Promise<CleanupResult>((resolve) => {
        resolveCleanup = resolve;
      });
      mockInvoke.mockReturnValue(cleanupPromise);

      renderHook(() => useAppLifecycle());

      await vi.waitFor(() => {
        expect(closeRequestedCallback).not.toBeNull();
      });

      const firstEvent = { preventDefault: vi.fn() };
      const secondEvent = { preventDefault: vi.fn() };

      let firstClosePromise: Promise<void> | null = null;
      act(() => {
        firstClosePromise = closeRequestedCallback!(firstEvent);
      });

      // While the first close is still running, trigger a second close request (e.g., user spam-clicks X).
      await act(async () => {
        await closeRequestedCallback!(secondEvent);
      });

      // Both events should be prevented while cleanup is running (we must not close early).
      expect(firstEvent.preventDefault).toHaveBeenCalled();
      expect(secondEvent.preventDefault).toHaveBeenCalled();

      // Cleanup should still only be invoked once.
      expect(mockInvoke).toHaveBeenCalledTimes(1);
      expect(mockClose).not.toHaveBeenCalled();

      // Finish cleanup and allow the first close to complete.
      resolveCleanup({
        projectSaved: false,
        workersShutdown: true,
        error: null,
      });

      await act(async () => {
        await firstClosePromise;
      });

      expect(mockClose).not.toHaveBeenCalled();
      expect(mockDestroy).toHaveBeenCalledTimes(1);
    });
  });

  describe('close handler with unsaved changes', () => {
    beforeEach(() => {
      mockStoreState = {
        isDirty: true,
        meta: { path: '/path/to/project' },
        saveProject: vi.fn().mockResolvedValue(undefined),
      };
    });

    it('should allow close to proceed when user chooses save and save succeeds', async () => {
      mockConfirm.mockResolvedValue(true); // Save and Close

      renderHook(() => useAppLifecycle());

      await vi.waitFor(() => {
        expect(closeRequestedCallback).not.toBeNull();
      });

      const mockEvent = { preventDefault: vi.fn() };
      await act(async () => {
        await closeRequestedCallback!(mockEvent);
      });

      expect(mockEvent.preventDefault).toHaveBeenCalled();
      expect(mockStoreState.saveProject).toHaveBeenCalled();
      expect(mockDestroy).toHaveBeenCalled();
    });

    it('should prevent close when save fails and user cancels closing', async () => {
      mockConfirm
        .mockResolvedValueOnce(true) // first confirm: Save and Close
        .mockResolvedValueOnce(false); // second confirm: Cancel

      mockStoreState = {
        isDirty: true,
        meta: { path: '/path/to/project' },
        saveProject: vi.fn().mockRejectedValue(new Error('Save failed')),
      };

      renderHook(() => useAppLifecycle());

      await vi.waitFor(() => {
        expect(closeRequestedCallback).not.toBeNull();
      });

      const mockEvent = { preventDefault: vi.fn() };
      await act(async () => {
        await closeRequestedCallback!(mockEvent);
      });

      expect(mockEvent.preventDefault).toHaveBeenCalled();
      expect(mockClose).not.toHaveBeenCalled();
      expect(mockDestroy).not.toHaveBeenCalled();
    });
  });

  describe('beforeunload handler', () => {
    it('should show browser confirmation when dirty', () => {
      // Browser environment: isTauri() is false so beforeunload is registered.
      isTauriMock.mockReturnValue(false);

      mockStoreState = {
        isDirty: true,
        meta: { path: '/path/to/project' },
        saveProject: vi.fn(),
      };

      renderHook(() => useAppLifecycle());

      // Create a mock beforeunload event
      const mockEvent = {
        preventDefault: vi.fn(),
        returnValue: '',
      };

      // Get the registered handler and call it
      const addEventListenerSpy = vi.spyOn(window, 'addEventListener');
      renderHook(() => useAppLifecycle());

      // Find the beforeunload handler that was registered
      const beforeunloadCall = addEventListenerSpy.mock.calls.find((call) => call[0] === 'beforeunload');
      if (beforeunloadCall) {
        const handler = beforeunloadCall[1] as (event: BeforeUnloadEvent) => string | void;
        const result = handler(mockEvent as unknown as BeforeUnloadEvent);

        expect(mockEvent.preventDefault).toHaveBeenCalled();
        expect(mockEvent.returnValue).toBe('You have unsaved changes.');
        expect(result).toBe('You have unsaved changes.');
      }

      addEventListenerSpy.mockRestore();
    });
  });
});
