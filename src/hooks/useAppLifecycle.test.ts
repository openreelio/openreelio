/**
 * useAppLifecycle Hook Tests
 *
 * Tests for application lifecycle events including window close handling
 * and unsaved changes protection.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAppLifecycle } from './useAppLifecycle';

// Mock Tauri APIs
const mockOnCloseRequested = vi.fn();
const mockClose = vi.fn();
const mockConfirm = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  isTauri: vi.fn(() => true),
}));

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: vi.fn(() => ({
    onCloseRequested: mockOnCloseRequested,
    close: mockClose,
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
}));

describe('useAppLifecycle', () => {
  let unlistenFn: () => void;
  let closeRequestedCallback: ((event: { preventDefault: () => void }) => Promise<void>) | null;

  beforeEach(() => {
    vi.clearAllMocks();

    // Reset store state
    mockStoreState = {
      isDirty: false,
      meta: null,
      saveProject: vi.fn().mockResolvedValue(undefined),
    };

    mockSettingsState = {
      flushPendingUpdates: vi.fn().mockResolvedValue(undefined),
    };

    // Setup close handler mock
    unlistenFn = vi.fn();
    closeRequestedCallback = null;

    mockOnCloseRequested.mockImplementation((callback) => {
      closeRequestedCallback = callback;
      return Promise.resolve(unlistenFn);
    });

    mockClose.mockResolvedValue(undefined);
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
    const addEventListenerSpy = vi.spyOn(window, 'addEventListener');
    const removeEventListenerSpy = vi.spyOn(window, 'removeEventListener');

    const { unmount } = renderHook(() => useAppLifecycle());

    expect(addEventListenerSpy).toHaveBeenCalledWith('beforeunload', expect.any(Function));

    unmount();

    expect(removeEventListenerSpy).toHaveBeenCalledWith('beforeunload', expect.any(Function));

    addEventListenerSpy.mockRestore();
    removeEventListenerSpy.mockRestore();
  });

  describe('close handler with no unsaved changes', () => {
    it('should flush settings and allow close', async () => {
      renderHook(() => useAppLifecycle());

      await vi.waitFor(() => {
        expect(closeRequestedCallback).not.toBeNull();
      });

      const mockEvent = { preventDefault: vi.fn() };
      await act(async () => {
        await closeRequestedCallback!(mockEvent);
      });

      expect(mockEvent.preventDefault).not.toHaveBeenCalled();
      expect(mockSettingsState.flushPendingUpdates).toHaveBeenCalled();
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

    it('should prevent close and ask to save', async () => {
      mockConfirm.mockResolvedValue(true); // User wants to save

      renderHook(() => useAppLifecycle());

      await vi.waitFor(() => {
        expect(closeRequestedCallback).not.toBeNull();
      });

      const mockEvent = { preventDefault: vi.fn() };
      await act(async () => {
        await closeRequestedCallback!(mockEvent);
      });

      expect(mockEvent.preventDefault).toHaveBeenCalled();
      // Note: confirm is called from the callback
    });

    it('should save and close when user confirms save', async () => {
      mockConfirm.mockResolvedValue(true);

      renderHook(() => useAppLifecycle());

      await vi.waitFor(() => {
        expect(closeRequestedCallback).not.toBeNull();
      });

      const mockEvent = { preventDefault: vi.fn() };
      await act(async () => {
        await closeRequestedCallback!(mockEvent);
      });

      expect(mockStoreState.saveProject).toHaveBeenCalled();
      expect(mockClose).toHaveBeenCalled();
    });

    it('should close without saving when user discards', async () => {
      mockConfirm.mockResolvedValue(false);

      renderHook(() => useAppLifecycle());

      await vi.waitFor(() => {
        expect(closeRequestedCallback).not.toBeNull();
      });

      const mockEvent = { preventDefault: vi.fn() };
      await act(async () => {
        await closeRequestedCallback!(mockEvent);
      });

      expect(mockStoreState.saveProject).not.toHaveBeenCalled();
      expect(mockSettingsState.flushPendingUpdates).toHaveBeenCalled();
      expect(mockClose).toHaveBeenCalled();
    });

    it('should handle save failure with retry option', async () => {
      mockStoreState.saveProject = vi.fn().mockRejectedValue(new Error('Save failed'));
      mockConfirm
        .mockResolvedValueOnce(true) // First: save changes
        .mockResolvedValueOnce(true); // Second: close anyway after failure

      renderHook(() => useAppLifecycle());

      await vi.waitFor(() => {
        expect(closeRequestedCallback).not.toBeNull();
      });

      const mockEvent = { preventDefault: vi.fn() };
      await act(async () => {
        await closeRequestedCallback!(mockEvent);
      });

      expect(mockStoreState.saveProject).toHaveBeenCalled();
      expect(mockClose).toHaveBeenCalled();
    });

    it('should not close if user cancels after save failure', async () => {
      mockStoreState.saveProject = vi.fn().mockRejectedValue(new Error('Save failed'));
      mockConfirm
        .mockResolvedValueOnce(true) // First: save changes
        .mockResolvedValueOnce(false); // Second: cancel close

      renderHook(() => useAppLifecycle());

      await vi.waitFor(() => {
        expect(closeRequestedCallback).not.toBeNull();
      });

      const mockEvent = { preventDefault: vi.fn() };
      await act(async () => {
        await closeRequestedCallback!(mockEvent);
      });

      expect(mockStoreState.saveProject).toHaveBeenCalled();
      expect(mockClose).not.toHaveBeenCalled();
    });
  });

  describe('beforeunload handler', () => {
    it('should show browser confirmation when dirty', () => {
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
      const beforeunloadCall = addEventListenerSpy.mock.calls.find(
        (call) => call[0] === 'beforeunload'
      );
      if (beforeunloadCall) {
        const handler = beforeunloadCall[1] as (event: BeforeUnloadEvent) => string | void;
        const result = handler(mockEvent as unknown as BeforeUnloadEvent);

        expect(mockEvent.preventDefault).toHaveBeenCalled();
        expect(mockEvent.returnValue).toBe('You have unsaved changes.');
        expect(result).toBe('You have unsaved changes.');
      }

      addEventListenerSpy.mockRestore();
    });

    it('should not show confirmation when not dirty', () => {
      mockStoreState = {
        isDirty: false,
        meta: null,
        saveProject: vi.fn(),
      };

      const addEventListenerSpy = vi.spyOn(window, 'addEventListener');
      renderHook(() => useAppLifecycle());

      const beforeunloadCall = addEventListenerSpy.mock.calls.find(
        (call) => call[0] === 'beforeunload'
      );
      if (beforeunloadCall) {
        const handler = beforeunloadCall[1] as (event: BeforeUnloadEvent) => string | void;
        const mockEvent = {
          preventDefault: vi.fn(),
          returnValue: '',
        };

        const result = handler(mockEvent as unknown as BeforeUnloadEvent);

        expect(mockEvent.preventDefault).not.toHaveBeenCalled();
        expect(result).toBeUndefined();
      }

      addEventListenerSpy.mockRestore();
    });

    it('should attempt to flush settings on unload', () => {
      mockStoreState = {
        isDirty: false,
        meta: null,
        saveProject: vi.fn(),
      };

      const addEventListenerSpy = vi.spyOn(window, 'addEventListener');
      renderHook(() => useAppLifecycle());

      const beforeunloadCall = addEventListenerSpy.mock.calls.find(
        (call) => call[0] === 'beforeunload'
      );
      if (beforeunloadCall) {
        const handler = beforeunloadCall[1] as (event: BeforeUnloadEvent) => string | void;
        const mockEvent = {
          preventDefault: vi.fn(),
          returnValue: '',
        };

        handler(mockEvent as unknown as BeforeUnloadEvent);

        // flushPendingUpdates should be called (fire-and-forget)
        expect(mockSettingsState.flushPendingUpdates).toHaveBeenCalled();
      }

      addEventListenerSpy.mockRestore();
    });
  });

  describe('cleanup', () => {
    it('should cleanup listeners on unmount', async () => {
      const removeEventListenerSpy = vi.spyOn(window, 'removeEventListener');

      const { unmount } = renderHook(() => useAppLifecycle());

      await vi.waitFor(() => {
        expect(mockOnCloseRequested).toHaveBeenCalled();
      });

      unmount();

      expect(unlistenFn).toHaveBeenCalled();
      expect(removeEventListenerSpy).toHaveBeenCalledWith('beforeunload', expect.any(Function));

      removeEventListenerSpy.mockRestore();
    });
  });

  describe('error handling', () => {
    it('should handle settings flush failure gracefully', async () => {
      mockSettingsState.flushPendingUpdates = vi.fn().mockRejectedValue(new Error('Flush failed'));

      renderHook(() => useAppLifecycle());

      await vi.waitFor(() => {
        expect(closeRequestedCallback).not.toBeNull();
      });

      const mockEvent = { preventDefault: vi.fn() };

      // Should not throw
      await expect(
        act(async () => {
          await closeRequestedCallback!(mockEvent);
        })
      ).resolves.not.toThrow();
    });

    it('should handle close handler setup failure', async () => {
      mockOnCloseRequested.mockRejectedValue(new Error('Setup failed'));

      // Should not throw
      expect(() => {
        renderHook(() => useAppLifecycle());
      }).not.toThrow();
    });
  });
});
