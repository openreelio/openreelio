/**
 * useAsyncCleanup Hook
 *
 * Provides utilities for safely handling asynchronous operations in React components.
 * Prevents memory leaks by tracking component mount state and providing cleanup mechanisms.
 *
 * Features:
 * - Track component mount/unmount state
 * - Safe setState that ignores updates after unmount
 * - AbortController management for fetch/async operations
 * - Cancellable promise execution
 *
 * @example
 * ```typescript
 * function MyComponent() {
 *   const { isActive, safeSetState, registerCleanup } = useAsyncCleanup();
 *   const [data, setData] = useState(null);
 *
 *   useEffect(() => {
 *     const controller = new AbortController();
 *     registerCleanup(() => controller.abort());
 *
 *     fetch('/api/data', { signal: controller.signal })
 *       .then(res => res.json())
 *       .then(data => safeSetState(setData, data))
 *       .catch(err => {
 *         if (!isActive) return; // Ignore if unmounted
 *         handleError(err);
 *       });
 *   }, []);
 * }
 * ```
 */

import { useRef, useEffect, useCallback, useState } from 'react';

// =============================================================================
// Types
// =============================================================================

/** Cleanup function type */
type CleanupFn = () => void;

/** useAsyncCleanup return type */
export interface AsyncCleanupResult {
  /** Whether the component is currently mounted */
  isActive: boolean;
  /** Register a cleanup function to run on unmount */
  registerCleanup: (cleanup: CleanupFn) => CleanupFn;
  /** Safely set state only if component is still mounted */
  safeSetState: <T>(setter: React.Dispatch<React.SetStateAction<T>>, value: T) => void;
  /** Run callback only if component is still mounted */
  runIfActive: <T>(callback: () => T) => T | undefined;
}

/** useAbortController return type */
export interface AbortControllerResult {
  /** The current AbortSignal */
  signal: AbortSignal;
  /** Abort the current operation */
  abort: () => void;
  /** Reset with a new AbortController */
  reset: () => void;
}

/** useCancellablePromise return type */
export interface CancellablePromiseResult<T> {
  /** Execute a promise-returning function */
  execute: (promiseFn: () => Promise<T>) => Promise<T | undefined>;
  /** Cancel the current operation */
  cancel: () => void;
  /** Whether an operation is currently in progress */
  isLoading: boolean;
  /** The last error that occurred */
  error: Error | null;
}

// =============================================================================
// useAsyncCleanup Hook
// =============================================================================

/**
 * Hook for safely managing async operations in components.
 *
 * @returns Cleanup utilities
 */
export function useAsyncCleanup(): AsyncCleanupResult {
  const isActiveRef = useRef(true);
  const cleanupsRef = useRef<Set<CleanupFn>>(new Set());

  // Run all cleanups on unmount
  useEffect(() => {
    isActiveRef.current = true;

    return () => {
      isActiveRef.current = false;

      // Run all registered cleanups
      cleanupsRef.current.forEach((cleanup) => {
        try {
          cleanup();
        } catch {
          // Silently ignore cleanup errors
        }
      });
      cleanupsRef.current.clear();
    };
  }, []);

  const registerCleanup = useCallback((cleanup: CleanupFn): CleanupFn => {
    cleanupsRef.current.add(cleanup);

    // Return unregister function
    return () => {
      cleanupsRef.current.delete(cleanup);
    };
  }, []);

  const safeSetState = useCallback(
    <T>(setter: React.Dispatch<React.SetStateAction<T>>, value: T): void => {
      if (isActiveRef.current) {
        setter(value);
      }
    },
    []
  );

  const runIfActive = useCallback(<T>(callback: () => T): T | undefined => {
    if (isActiveRef.current) {
      return callback();
    }
    return undefined;
  }, []);

  return {
    get isActive() {
      return isActiveRef.current;
    },
    registerCleanup,
    safeSetState,
    runIfActive,
  };
}

// =============================================================================
// useAbortController Hook
// =============================================================================

/**
 * Hook for managing an AbortController that auto-aborts on unmount.
 *
 * @returns AbortController utilities
 *
 * @example
 * ```typescript
 * function MyComponent() {
 *   const { signal, abort, reset } = useAbortController();
 *
 *   useEffect(() => {
 *     fetch('/api/data', { signal })
 *       .then(handleSuccess)
 *       .catch(handleError);
 *   }, [signal]);
 *
 *   return <button onClick={abort}>Cancel</button>;
 * }
 * ```
 */
export function useAbortController(): AbortControllerResult {
  const controllerRef = useRef<AbortController>(new AbortController());

  useEffect(() => {
    // Create new controller on mount
    controllerRef.current = new AbortController();

    return () => {
      // Abort on unmount
      controllerRef.current.abort();
    };
  }, []);

  const abort = useCallback(() => {
    controllerRef.current.abort();
  }, []);

  const reset = useCallback(() => {
    controllerRef.current = new AbortController();
  }, []);

  return {
    get signal() {
      return controllerRef.current.signal;
    },
    abort,
    reset,
  };
}

// =============================================================================
// useCancellablePromise Hook
// =============================================================================

/**
 * Hook for executing cancellable promises with loading/error state.
 *
 * @returns Promise execution utilities
 *
 * @example
 * ```typescript
 * function MyComponent() {
 *   const { execute, cancel, isLoading, error } = useCancellablePromise<Data>();
 *   const [data, setData] = useState<Data | null>(null);
 *
 *   const loadData = () => {
 *     execute(async () => {
 *       const response = await fetch('/api/data');
 *       return response.json();
 *     }).then(result => {
 *       if (result) setData(result);
 *     });
 *   };
 *
 *   return (
 *     <>
 *       {isLoading && <Spinner />}
 *       {error && <Error message={error.message} />}
 *       <button onClick={loadData}>Load</button>
 *       <button onClick={cancel}>Cancel</button>
 *     </>
 *   );
 * }
 * ```
 */
export function useCancellablePromise<T>(): CancellablePromiseResult<T> {
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [error, setError] = useState<Error | null>(null);

  const isActiveRef = useRef(true);
  const cancelledRef = useRef(false);
  const currentPromiseRef = useRef<Promise<T> | null>(null);

  // Track mount state
  useEffect(() => {
    isActiveRef.current = true;
    cancelledRef.current = false;
    return () => {
      isActiveRef.current = false;
      cancelledRef.current = true;
    };
  }, []);

  const cancel = useCallback(() => {
    cancelledRef.current = true;
    if (isActiveRef.current) {
      setIsLoading(false);
    }
  }, []);

  const execute = useCallback(
    async (promiseFn: () => Promise<T>): Promise<T | undefined> => {
      // Reset state
      cancelledRef.current = false;
      if (isActiveRef.current) {
        setIsLoading(true);
        setError(null);
      }

      try {
        const promise = promiseFn();
        currentPromiseRef.current = promise;

        const result = await promise;

        // Check if cancelled or unmounted
        if (cancelledRef.current || !isActiveRef.current) {
          return undefined;
        }

        setIsLoading(false);
        return result;
      } catch (err) {
        // Check if cancelled or unmounted
        if (cancelledRef.current || !isActiveRef.current) {
          return undefined;
        }

        const errorObj = err instanceof Error ? err : new Error(String(err));
        setError(errorObj);
        setIsLoading(false);
        throw errorObj;
      }
    },
    []
  );

  return {
    execute,
    cancel,
    isLoading,
    error,
  };
}

// =============================================================================
// Exports
// =============================================================================

export default useAsyncCleanup;
