/**
 * useToast Hook Tests
 *
 * Tests for toast notification state management including:
 * - Adding toasts with various variants
 * - Removing individual toasts
 * - Clearing all toasts
 * - Toast store functionality
 */

import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useToast, useToastStore } from './useToast';

// =============================================================================
// Test Setup
// =============================================================================

describe('useToast', () => {
  beforeEach(() => {
    // Reset store state before each test
    useToastStore.getState().clearToasts();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ===========================================================================
  // Initial State
  // ===========================================================================

  describe('initial state', () => {
    it('should start with empty toasts array', () => {
      const { result } = renderHook(() => useToast());
      expect(result.current.toasts).toEqual([]);
    });
  });

  // ===========================================================================
  // showToast
  // ===========================================================================

  describe('showToast', () => {
    it('should add a toast with default info variant', () => {
      const { result } = renderHook(() => useToast());

      act(() => {
        result.current.showToast('Test message');
      });

      expect(result.current.toasts).toHaveLength(1);
      expect(result.current.toasts[0].message).toBe('Test message');
      expect(result.current.toasts[0].variant).toBe('info');
    });

    it('should add a toast with specified variant', () => {
      const { result } = renderHook(() => useToast());

      act(() => {
        result.current.showToast('Error message', 'error');
      });

      expect(result.current.toasts[0].variant).toBe('error');
    });

    it('should add a toast with custom duration', () => {
      const { result } = renderHook(() => useToast());

      act(() => {
        result.current.showToast('Timed message', 'info', 3000);
      });

      expect(result.current.toasts[0].duration).toBe(3000);
    });

    it('should return the toast id', () => {
      const { result } = renderHook(() => useToast());
      let toastId: string = '';

      act(() => {
        toastId = result.current.showToast('Test message');
      });

      expect(typeof toastId).toBe('string');
      expect(toastId.startsWith('toast-')).toBe(true);
    });

    it('should generate unique ids for each toast', () => {
      const { result } = renderHook(() => useToast());
      const ids: string[] = [];

      act(() => {
        ids.push(result.current.showToast('Message 1'));
        ids.push(result.current.showToast('Message 2'));
        ids.push(result.current.showToast('Message 3'));
      });

      // All IDs should be unique
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(3);
    });
  });

  // ===========================================================================
  // Variant Helpers
  // ===========================================================================

  describe('variant helpers', () => {
    describe('showSuccess', () => {
      it('should add a success toast', () => {
        const { result } = renderHook(() => useToast());

        act(() => {
          result.current.showSuccess('Operation successful');
        });

        expect(result.current.toasts[0].variant).toBe('success');
        expect(result.current.toasts[0].message).toBe('Operation successful');
      });

      it('should accept custom duration', () => {
        const { result } = renderHook(() => useToast());

        act(() => {
          result.current.showSuccess('Success!', 2000);
        });

        expect(result.current.toasts[0].duration).toBe(2000);
      });
    });

    describe('showError', () => {
      it('should add an error toast', () => {
        const { result } = renderHook(() => useToast());

        act(() => {
          result.current.showError('Something went wrong');
        });

        expect(result.current.toasts[0].variant).toBe('error');
        expect(result.current.toasts[0].message).toBe('Something went wrong');
      });

      it('should use longer default duration for errors', () => {
        const { result } = renderHook(() => useToast());

        act(() => {
          result.current.showError('Error message');
        });

        // Error toasts should have 6000ms default duration
        expect(result.current.toasts[0].duration).toBe(6000);
      });

      it('should allow custom duration to override default', () => {
        const { result } = renderHook(() => useToast());

        act(() => {
          result.current.showError('Error message', 10000);
        });

        expect(result.current.toasts[0].duration).toBe(10000);
      });
    });

    describe('showWarning', () => {
      it('should add a warning toast', () => {
        const { result } = renderHook(() => useToast());

        act(() => {
          result.current.showWarning('Please be careful');
        });

        expect(result.current.toasts[0].variant).toBe('warning');
        expect(result.current.toasts[0].message).toBe('Please be careful');
      });

      it('should accept custom duration', () => {
        const { result } = renderHook(() => useToast());

        act(() => {
          result.current.showWarning('Warning!', 5000);
        });

        expect(result.current.toasts[0].duration).toBe(5000);
      });
    });

    describe('showInfo', () => {
      it('should add an info toast', () => {
        const { result } = renderHook(() => useToast());

        act(() => {
          result.current.showInfo('Here is some information');
        });

        expect(result.current.toasts[0].variant).toBe('info');
        expect(result.current.toasts[0].message).toBe('Here is some information');
      });

      it('should accept custom duration', () => {
        const { result } = renderHook(() => useToast());

        act(() => {
          result.current.showInfo('Info message', 4000);
        });

        expect(result.current.toasts[0].duration).toBe(4000);
      });
    });
  });

  // ===========================================================================
  // dismissToast
  // ===========================================================================

  describe('dismissToast', () => {
    it('should remove a toast by id', () => {
      const { result } = renderHook(() => useToast());
      let toastId: string = '';

      act(() => {
        toastId = result.current.showToast('Test message');
      });

      expect(result.current.toasts).toHaveLength(1);

      act(() => {
        result.current.dismissToast(toastId);
      });

      expect(result.current.toasts).toHaveLength(0);
    });

    it('should only remove the specified toast', () => {
      const { result } = renderHook(() => useToast());
      let toastId1: string = '';
      let toastId2: string = '';

      act(() => {
        toastId1 = result.current.showToast('Message 1');
        toastId2 = result.current.showToast('Message 2');
      });

      expect(result.current.toasts).toHaveLength(2);

      act(() => {
        result.current.dismissToast(toastId1);
      });

      expect(result.current.toasts).toHaveLength(1);
      expect(result.current.toasts[0].id).toBe(toastId2);
    });

    it('should do nothing if id does not exist', () => {
      const { result } = renderHook(() => useToast());

      act(() => {
        result.current.showToast('Test message');
      });

      const toastCountBefore = result.current.toasts.length;

      act(() => {
        result.current.dismissToast('non-existent-id');
      });

      expect(result.current.toasts.length).toBe(toastCountBefore);
    });
  });

  // ===========================================================================
  // clearAll
  // ===========================================================================

  describe('clearAll', () => {
    it('should remove all toasts', () => {
      const { result } = renderHook(() => useToast());

      act(() => {
        result.current.showToast('Message 1');
        result.current.showToast('Message 2');
        result.current.showToast('Message 3');
      });

      expect(result.current.toasts).toHaveLength(3);

      act(() => {
        result.current.clearAll();
      });

      expect(result.current.toasts).toHaveLength(0);
    });

    it('should do nothing when no toasts exist', () => {
      const { result } = renderHook(() => useToast());

      act(() => {
        result.current.clearAll();
      });

      expect(result.current.toasts).toHaveLength(0);
    });
  });

  // ===========================================================================
  // Multiple Hooks
  // ===========================================================================

  describe('multiple hooks', () => {
    it('should share state between hook instances', () => {
      const { result: result1 } = renderHook(() => useToast());
      const { result: result2 } = renderHook(() => useToast());

      act(() => {
        result1.current.showToast('Message from hook 1');
      });

      // Both hooks should see the same toast
      expect(result1.current.toasts).toHaveLength(1);
      expect(result2.current.toasts).toHaveLength(1);
      expect(result1.current.toasts[0].message).toBe('Message from hook 1');
      expect(result2.current.toasts[0].message).toBe('Message from hook 1');
    });

    it('should update all hooks when toast is dismissed', () => {
      const { result: result1 } = renderHook(() => useToast());
      const { result: result2 } = renderHook(() => useToast());
      let toastId: string = '';

      act(() => {
        toastId = result1.current.showToast('Test message');
      });

      act(() => {
        result2.current.dismissToast(toastId);
      });

      expect(result1.current.toasts).toHaveLength(0);
      expect(result2.current.toasts).toHaveLength(0);
    });
  });

  // ===========================================================================
  // Toast Data Structure
  // ===========================================================================

  describe('toast data structure', () => {
    it('should have correct structure for toast data', () => {
      const { result } = renderHook(() => useToast());

      act(() => {
        result.current.showToast('Test message', 'success', 5000);
      });

      const toast = result.current.toasts[0];
      expect(toast).toHaveProperty('id');
      expect(toast).toHaveProperty('message', 'Test message');
      expect(toast).toHaveProperty('variant', 'success');
      expect(toast).toHaveProperty('duration', 5000);
    });

    it('should have undefined duration when not specified', () => {
      const { result } = renderHook(() => useToast());

      act(() => {
        result.current.showToast('Test message');
      });

      expect(result.current.toasts[0].duration).toBeUndefined();
    });
  });

  // ===========================================================================
  // Return Value Interface
  // ===========================================================================

  describe('return value interface', () => {
    it('should return all expected properties', () => {
      const { result } = renderHook(() => useToast());

      expect(result.current).toHaveProperty('toasts');
      expect(result.current).toHaveProperty('showToast');
      expect(result.current).toHaveProperty('showSuccess');
      expect(result.current).toHaveProperty('showError');
      expect(result.current).toHaveProperty('showWarning');
      expect(result.current).toHaveProperty('showInfo');
      expect(result.current).toHaveProperty('dismissToast');
      expect(result.current).toHaveProperty('clearAll');
    });

    it('should return functions for all actions', () => {
      const { result } = renderHook(() => useToast());

      expect(typeof result.current.showToast).toBe('function');
      expect(typeof result.current.showSuccess).toBe('function');
      expect(typeof result.current.showError).toBe('function');
      expect(typeof result.current.showWarning).toBe('function');
      expect(typeof result.current.showInfo).toBe('function');
      expect(typeof result.current.dismissToast).toBe('function');
      expect(typeof result.current.clearAll).toBe('function');
    });
  });
});

// =============================================================================
// useToastStore Tests
// =============================================================================

describe('useToastStore', () => {
  beforeEach(() => {
    useToastStore.getState().clearToasts();
  });

  it('should be a Zustand store', () => {
    expect(useToastStore).toBeDefined();
    expect(typeof useToastStore.getState).toBe('function');
    expect(typeof useToastStore.setState).toBe('function');
  });

  describe('addToast', () => {
    it('should add toast to store', () => {
      const state = useToastStore.getState();
      state.addToast('Test message', 'info');

      expect(useToastStore.getState().toasts).toHaveLength(1);
    });

    it('should return toast id', () => {
      const state = useToastStore.getState();
      const id = state.addToast('Test message', 'info');

      expect(typeof id).toBe('string');
      expect(id.startsWith('toast-')).toBe(true);
    });
  });

  describe('removeToast', () => {
    it('should remove toast from store', () => {
      const state = useToastStore.getState();
      const id = state.addToast('Test message', 'info');

      useToastStore.getState().removeToast(id);

      expect(useToastStore.getState().toasts).toHaveLength(0);
    });
  });

  describe('clearToasts', () => {
    it('should clear all toasts from store', () => {
      const state = useToastStore.getState();
      state.addToast('Message 1', 'info');
      state.addToast('Message 2', 'success');

      useToastStore.getState().clearToasts();

      expect(useToastStore.getState().toasts).toHaveLength(0);
    });
  });
});
