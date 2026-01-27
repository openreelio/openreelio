/**
 * useAsyncCleanup Hook Tests
 *
 * TDD: RED phase - Tests written before implementation
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import {
  useAsyncCleanup,
  useAbortController,
  useCancellablePromise,
} from './useAsyncCleanup';

describe('useAsyncCleanup', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('basic cleanup tracking', () => {
    it('should return isActive true when mounted', () => {
      const { result } = renderHook(() => useAsyncCleanup());

      expect(result.current.isActive).toBe(true);
    });

    it('should return isActive false after unmount', () => {
      const { result, unmount } = renderHook(() => useAsyncCleanup());

      unmount();

      expect(result.current.isActive).toBe(false);
    });

    it('should cleanup registered functions on unmount', () => {
      const cleanup1 = vi.fn();
      const cleanup2 = vi.fn();

      const { result, unmount } = renderHook(() => useAsyncCleanup());

      act(() => {
        result.current.registerCleanup(cleanup1);
        result.current.registerCleanup(cleanup2);
      });

      unmount();

      expect(cleanup1).toHaveBeenCalledTimes(1);
      expect(cleanup2).toHaveBeenCalledTimes(1);
    });

    it('should allow manual cleanup removal', () => {
      const cleanup = vi.fn();

      const { result, unmount } = renderHook(() => useAsyncCleanup());

      let unregister: () => void;
      act(() => {
        unregister = result.current.registerCleanup(cleanup);
      });

      act(() => {
        unregister();
      });

      unmount();

      expect(cleanup).not.toHaveBeenCalled();
    });
  });

  describe('safeSetState', () => {
    it('should call setState when component is mounted', () => {
      const setState = vi.fn();
      const { result } = renderHook(() => useAsyncCleanup());

      act(() => {
        result.current.safeSetState(setState, 'new value');
      });

      expect(setState).toHaveBeenCalledWith('new value');
    });

    it('should not call setState after unmount', () => {
      const setState = vi.fn();
      const { result, unmount } = renderHook(() => useAsyncCleanup());

      unmount();

      result.current.safeSetState(setState, 'new value');

      expect(setState).not.toHaveBeenCalled();
    });

    it('should work with async operations', async () => {
      const setState = vi.fn();
      const { result, unmount } = renderHook(() => useAsyncCleanup());

      // Start an async operation
      const asyncOperation = async () => {
        await vi.advanceTimersByTimeAsync(1000);
        result.current.safeSetState(setState, 'done');
      };

      const promise = asyncOperation();

      // Unmount before operation completes
      unmount();

      await promise;

      expect(setState).not.toHaveBeenCalled();
    });
  });

  describe('runIfActive', () => {
    it('should run callback when active', () => {
      const callback = vi.fn().mockReturnValue('result');
      const { result } = renderHook(() => useAsyncCleanup());

      let returnValue: string | undefined;
      act(() => {
        returnValue = result.current.runIfActive(callback);
      });

      expect(callback).toHaveBeenCalled();
      expect(returnValue).toBe('result');
    });

    it('should not run callback after unmount', () => {
      const callback = vi.fn();
      const { result, unmount } = renderHook(() => useAsyncCleanup());

      unmount();

      const returnValue = result.current.runIfActive(callback);

      expect(callback).not.toHaveBeenCalled();
      expect(returnValue).toBeUndefined();
    });
  });
});

describe('useAbortController', () => {
  it('should return an AbortController', () => {
    const { result } = renderHook(() => useAbortController());

    expect(result.current.signal).toBeInstanceOf(AbortSignal);
    expect(result.current.abort).toBeInstanceOf(Function);
  });

  it('should abort on unmount', () => {
    const { result, unmount } = renderHook(() => useAbortController());
    const signal = result.current.signal;

    expect(signal.aborted).toBe(false);

    unmount();

    expect(signal.aborted).toBe(true);
  });

  it('should allow manual abort', () => {
    const { result } = renderHook(() => useAbortController());

    expect(result.current.signal.aborted).toBe(false);

    act(() => {
      result.current.abort();
    });

    expect(result.current.signal.aborted).toBe(true);
  });

  it('should reset controller when reset is called', () => {
    const { result } = renderHook(() => useAbortController());
    const firstSignal = result.current.signal;

    act(() => {
      result.current.abort();
    });

    expect(firstSignal.aborted).toBe(true);

    act(() => {
      result.current.reset();
    });

    expect(result.current.signal).not.toBe(firstSignal);
    expect(result.current.signal.aborted).toBe(false);
  });
});

describe('useCancellablePromise', () => {
  it('should return execute function and state', () => {
    const { result } = renderHook(() => useCancellablePromise());

    expect(result.current.execute).toBeInstanceOf(Function);
    expect(result.current.cancel).toBeInstanceOf(Function);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('should execute promise and track loading state', async () => {
    const { result } = renderHook(() => useCancellablePromise<string>());

    // Start execution
    let resolvePromise: (value: string) => void;
    let promise: Promise<string | undefined>;
    act(() => {
      promise = result.current.execute(
        () =>
          new Promise<string>((resolve) => {
            resolvePromise = resolve;
          })
      );
    });

    // Loading should be true immediately after starting
    await waitFor(() => {
      expect(result.current.isLoading).toBe(true);
    });

    // Resolve the promise
    await act(async () => {
      resolvePromise!('success');
      await promise;
    });

    // Loading should be false after completion
    expect(result.current.isLoading).toBe(false);
  });

  it('should cancel promise on unmount', async () => {
    const { result, unmount } = renderHook(() => useCancellablePromise<string>());

    // Start a promise that will never resolve
    let rejectPromise: (error: Error) => void;
    act(() => {
      result.current.execute(
        () =>
          new Promise<string>((_, reject) => {
            rejectPromise = reject;
          })
      );
    });

    // Unmount before resolution
    unmount();

    // The promise rejection should not cause issues after unmount
    rejectPromise!(new Error('cancelled'));
  });

  it('should handle errors', async () => {
    const { result } = renderHook(() => useCancellablePromise<string>());

    await act(async () => {
      try {
        await result.current.execute(() => Promise.reject(new Error('test error')));
      } catch {
        // Expected
      }
    });

    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.error?.message).toBe('test error');
    expect(result.current.isLoading).toBe(false);
  });

  it('should clear error on new execution', async () => {
    const { result } = renderHook(() => useCancellablePromise<string>());

    // First, cause an error
    await act(async () => {
      try {
        await result.current.execute(() => Promise.reject(new Error('error')));
      } catch {
        // Expected
      }
    });

    expect(result.current.error).not.toBeNull();

    // Then execute successfully
    await act(async () => {
      await result.current.execute(() => Promise.resolve('success'));
    });

    expect(result.current.error).toBeNull();
  });

  it('should support manual cancellation', async () => {
    const { result } = renderHook(() => useCancellablePromise<string>());

    // Start a promise that will never resolve naturally
    let resolvePromise: (value: string) => void;
    act(() => {
      result.current.execute(
        () =>
          new Promise<string>((resolve) => {
            resolvePromise = resolve;
          })
      );
    });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(true);
    });

    act(() => {
      result.current.cancel();
    });

    expect(result.current.isLoading).toBe(false);

    // Resolve the underlying promise (should be ignored)
    resolvePromise!('done');
  });
});
