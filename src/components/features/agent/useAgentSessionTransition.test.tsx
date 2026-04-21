import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useAgentSessionTransition } from './useAgentSessionTransition';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve'];
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });

  return { promise, resolve };
}

describe('useAgentSessionTransition', () => {
  it('should keep the latest transition pending when an older one settles first', async () => {
    const firstDeferred = createDeferred<void>();
    const secondDeferred = createDeferred<void>();
    const { result } = renderHook(() => useAgentSessionTransition());

    let firstTransition!: Promise<void>;
    let secondTransition!: Promise<void>;

    act(() => {
      firstTransition = result.current.runSessionTransition('new', () => firstDeferred.promise);
    });

    act(() => {
      secondTransition = result.current.runSessionTransition(
        'delegate',
        () => secondDeferred.promise,
      );
    });

    expect(result.current.isSessionTransitionPending).toBe(true);
    expect(result.current.sessionTransitionLabel).toBe('delegate');

    await act(async () => {
      firstDeferred.resolve();
      await firstTransition;
    });

    expect(result.current.isSessionTransitionPending).toBe(true);
    expect(result.current.sessionTransitionLabel).toBe('delegate');

    await act(async () => {
      secondDeferred.resolve();
      await secondTransition;
    });

    await waitFor(() => {
      expect(result.current.isSessionTransitionPending).toBe(false);
      expect(result.current.sessionTransitionLabel).toBeNull();
    });
  });
});
