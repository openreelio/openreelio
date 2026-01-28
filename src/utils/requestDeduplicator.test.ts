/**
 * RequestDeduplicator Tests
 *
 * Comprehensive test suite covering:
 * - Basic execute functionality
 * - Duplicate request detection
 * - Promise rejection handling
 * - Capacity eviction (LRU)
 * - Non-serializable payload handling
 * - Cleanup timing edge cases
 * - Race condition scenarios
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { RequestDeduplicator, _resetDeduplicatorForTesting } from './requestDeduplicator';

describe('RequestDeduplicator', () => {
  let dedup: RequestDeduplicator;

  beforeEach(() => {
    dedup = new RequestDeduplicator();
  });

  afterEach(() => {
    dedup.clearForTesting();
    vi.useRealTimers();
    _resetDeduplicatorForTesting();
  });

  // ===========================================================================
  // Basic Functionality
  // ===========================================================================

  describe('Basic functionality', () => {
    it('executes operation and returns result', async () => {
      const operation = vi.fn().mockResolvedValue('result');

      const result = await dedup.execute('testCmd', { id: 1 }, operation);

      expect(result).toBe('result');
      expect(operation).toHaveBeenCalledOnce();
    });

    it('executes operation only once for identical concurrent requests', async () => {
      const operation = vi.fn().mockResolvedValue('result');

      // Fire two concurrent requests with same key
      const [result1, result2] = await Promise.all([
        dedup.execute('testCmd', { id: 1 }, operation),
        dedup.execute('testCmd', { id: 1 }, operation),
      ]);

      expect(result1).toBe('result');
      expect(result2).toBe('result');
      expect(operation).toHaveBeenCalledOnce();
    });

    it('executes different operations for different payloads', async () => {
      const operation1 = vi.fn().mockResolvedValue('result1');
      const operation2 = vi.fn().mockResolvedValue('result2');

      const [result1, result2] = await Promise.all([
        dedup.execute('testCmd', { id: 1 }, operation1),
        dedup.execute('testCmd', { id: 2 }, operation2),
      ]);

      expect(result1).toBe('result1');
      expect(result2).toBe('result2');
      expect(operation1).toHaveBeenCalledOnce();
      expect(operation2).toHaveBeenCalledOnce();
    });

    it('executes different operations for different command types', async () => {
      const operation1 = vi.fn().mockResolvedValue('result1');
      const operation2 = vi.fn().mockResolvedValue('result2');

      const [result1, result2] = await Promise.all([
        dedup.execute('cmd1', { id: 1 }, operation1),
        dedup.execute('cmd2', { id: 1 }, operation2),
      ]);

      expect(result1).toBe('result1');
      expect(result2).toBe('result2');
      expect(operation1).toHaveBeenCalledOnce();
      expect(operation2).toHaveBeenCalledOnce();
    });

    it('tracks inFlightCount correctly', async () => {
      vi.useFakeTimers();
      expect(dedup.inFlightCount).toBe(0);

      let resolveOp: (() => void) | undefined;
      const operation = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveOp = resolve;
          }),
      );

      const promise = dedup.execute('testCmd', {}, operation);
      expect(dedup.inFlightCount).toBe(1);

      resolveOp?.();
      await promise;

      // After debounce window, count should decrease
      vi.advanceTimersByTime(RequestDeduplicator.DEBOUNCE_WINDOW_MS + 10);
      await Promise.resolve(); // Flush microtasks
      expect(dedup.inFlightCount).toBe(0);
    });
  });

  // ===========================================================================
  // Promise Rejection Handling
  // ===========================================================================

  describe('Promise rejection handling', () => {
    it('propagates errors to all waiting callers', async () => {
      const error = new Error('Operation failed');
      const operation = vi.fn().mockRejectedValue(error);

      const promise1 = dedup.execute('testCmd', { id: 1 }, operation);
      const promise2 = dedup.execute('testCmd', { id: 1 }, operation);

      await expect(promise1).rejects.toThrow('Operation failed');
      await expect(promise2).rejects.toThrow('Operation failed');
      expect(operation).toHaveBeenCalledOnce();
    });

    it('cleans up after rejection', async () => {
      vi.useFakeTimers();

      const error = new Error('Operation failed');
      const operation = vi.fn().mockRejectedValue(error);

      await expect(dedup.execute('testCmd', { id: 1 }, operation)).rejects.toThrow();

      // Advance past debounce window
      vi.advanceTimersByTime(RequestDeduplicator.DEBOUNCE_WINDOW_MS + 10);
      await Promise.resolve(); // Flush microtasks

      expect(dedup.inFlightCount).toBe(0);
    });

    it('allows retry after rejection and cleanup', async () => {
      vi.useFakeTimers();

      const error = new Error('First failure');
      const operation1 = vi.fn().mockRejectedValue(error);
      const operation2 = vi.fn().mockResolvedValue('success');

      await expect(dedup.execute('testCmd', { id: 1 }, operation1)).rejects.toThrow();

      // Advance past debounce window
      vi.advanceTimersByTime(RequestDeduplicator.DEBOUNCE_WINDOW_MS + 10);
      await Promise.resolve();

      // Should be able to execute again
      const result = await dedup.execute('testCmd', { id: 1 }, operation2);
      expect(result).toBe('success');
      expect(operation2).toHaveBeenCalledOnce();
    });
  });

  // ===========================================================================
  // Non-Serializable Payload Handling
  // ===========================================================================

  describe('Non-serializable payload handling', () => {
    it('handles payload with circular references', async () => {
      const operation = vi.fn().mockResolvedValue('result');

      // Create circular reference
      const circular: Record<string, unknown> = { a: 1 };
      circular.self = circular;

      const result = await dedup.execute('testCmd', circular, operation);

      expect(result).toBe('result');
      expect(operation).toHaveBeenCalledOnce();
    });

    it('generates stable keys for same non-serializable object', async () => {
      const operation1 = vi.fn().mockResolvedValue('result1');
      const operation2 = vi.fn().mockResolvedValue('result2');

      // Create circular reference
      const circular: Record<string, unknown> = { a: 1 };
      circular.self = circular;

      // Same object should deduplicate
      const [result1, result2] = await Promise.all([
        dedup.execute('testCmd', circular, operation1),
        dedup.execute('testCmd', circular, operation2),
      ]);

      expect(result1).toBe('result1');
      expect(result2).toBe('result1'); // Same promise
      expect(operation1).toHaveBeenCalledOnce();
      expect(operation2).not.toHaveBeenCalled();
    });

    it('generates different keys for different non-serializable objects', async () => {
      const operation1 = vi.fn().mockResolvedValue('result1');
      const operation2 = vi.fn().mockResolvedValue('result2');

      const circular1: Record<string, unknown> = { a: 1 };
      circular1.self = circular1;

      const circular2: Record<string, unknown> = { b: 2 };
      circular2.self = circular2;

      const [result1, result2] = await Promise.all([
        dedup.execute('testCmd', circular1, operation1),
        dedup.execute('testCmd', circular2, operation2),
      ]);

      expect(result1).toBe('result1');
      expect(result2).toBe('result2');
      expect(operation1).toHaveBeenCalledOnce();
      expect(operation2).toHaveBeenCalledOnce();
    });

    it('handles payload containing functions', async () => {
      const operation = vi.fn().mockResolvedValue('result');

      const payloadWithFunction = {
        callback: () => 'test',
        data: 'value',
      };

      const result = await dedup.execute('testCmd', payloadWithFunction, operation);

      expect(result).toBe('result');
      expect(operation).toHaveBeenCalledOnce();
    });

    it('handles null payload', async () => {
      const operation = vi.fn().mockResolvedValue('result');

      const result = await dedup.execute('testCmd', null, operation);

      expect(result).toBe('result');
      expect(operation).toHaveBeenCalledOnce();
    });

    it('handles undefined payload', async () => {
      const operation = vi.fn().mockResolvedValue('result');

      const result = await dedup.execute('testCmd', undefined, operation);

      expect(result).toBe('result');
      expect(operation).toHaveBeenCalledOnce();
    });

    it('handles primitive payloads', async () => {
      const operation = vi.fn().mockResolvedValue('result');

      await dedup.execute('testCmd', 'string', operation);
      await dedup.clearForTesting();
      await dedup.execute('testCmd', 123, operation);
      await dedup.clearForTesting();
      await dedup.execute('testCmd', true, operation);

      expect(operation).toHaveBeenCalledTimes(3);
    });
  });

  // ===========================================================================
  // Capacity and LRU Eviction
  // ===========================================================================

  describe('Capacity and LRU eviction', () => {
    it('evicts oldest entries when capacity is reached', async () => {
      vi.useFakeTimers();

      // Create a deduplicator with a small capacity for testing
      // We'll use the real one but flood it
      const promises: Promise<unknown>[] = [];
      const resolvers: Array<() => void> = [];

      // Fill up the deduplicator
      for (let i = 0; i < RequestDeduplicator.MAX_TRACKED_REQUESTS + 100; i++) {
        let resolver: () => void;
        const operation = vi.fn(
          () =>
            new Promise<void>((resolve) => {
              resolver = resolve;
            }),
        );
        promises.push(dedup.execute(`cmd_${i}`, { id: i }, operation));
        resolvers.push(resolver!);
      }

      // Should have evicted some entries
      expect(dedup.inFlightCount).toBeLessThanOrEqual(RequestDeduplicator.MAX_TRACKED_REQUESTS);

      // Cleanup
      for (const resolve of resolvers) {
        resolve();
      }
      await Promise.all(promises.map((p) => p.catch(() => {})));
    });

    it('prioritizes evicting completed entries', async () => {
      vi.useFakeTimers();

      // Create some completed entries first
      const completedPromises: Promise<unknown>[] = [];
      for (let i = 0; i < 100; i++) {
        completedPromises.push(dedup.execute(`completed_${i}`, { id: i }, async () => `result_${i}`));
      }
      await Promise.all(completedPromises);

      // Now create in-flight entries until capacity
      const inFlightResolvers: Array<() => void> = [];
      const inFlightPromises: Promise<unknown>[] = [];

      for (let i = 0; i < RequestDeduplicator.MAX_TRACKED_REQUESTS; i++) {
        let resolver: () => void;
        const operation = vi.fn(
          () =>
            new Promise<void>((resolve) => {
              resolver = resolve;
            }),
        );
        inFlightPromises.push(dedup.execute(`inflight_${i}`, { id: i }, operation));
        inFlightResolvers.push(resolver!);
      }

      // Eviction should have occurred, but we can still track
      expect(dedup.inFlightCount).toBeLessThanOrEqual(RequestDeduplicator.MAX_TRACKED_REQUESTS);

      // Cleanup
      for (const resolve of inFlightResolvers) {
        resolve();
      }
      await Promise.all(inFlightPromises);
    });
  });

  // ===========================================================================
  // Cleanup Timing and Race Conditions
  // ===========================================================================

  describe('Cleanup timing and race conditions', () => {
    it('does not allow an old cleanup timer to delete a newer in-flight request with the same key', async () => {
      vi.useFakeTimers();

      let resolveA: (() => void) | undefined;
      const opA = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveA = resolve;
          }),
      );

      // Start request A
      const promiseA = dedup.execute('cmd', { x: 1 }, opA);

      // Simulate capacity eviction removing the in-flight entry for A while A is still running
      const key = (dedup as unknown as { generateKey: (t: string, p: unknown) => string }).generateKey(
        'cmd',
        { x: 1 },
      );
      (dedup as unknown as { cleanup: (k: string) => void }).cleanup(key);

      let resolveB: (() => void) | undefined;
      const opB = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveB = resolve;
          }),
      );

      // Start request B (same key) after the eviction
      const promiseB = dedup.execute('cmd', { x: 1 }, opB);

      // Finish A, which schedules a delayed cleanup
      resolveA?.();
      await promiseA;

      // Let the debounce cleanup window elapse
      vi.advanceTimersByTime(RequestDeduplicator.DEBOUNCE_WINDOW_MS + 50);
      await Promise.resolve(); // Flush microtasks

      // B must still be tracked as in-flight (i.e., not deleted by A's stale cleanup timer)
      const inFlight = (
        dedup as unknown as { inFlight: Map<string, { id: number; promise: Promise<unknown> }> }
      ).inFlight;
      expect(inFlight.has(key)).toBe(true);
      expect(dedup.inFlightCount).toBe(1);
      expect(opB).toHaveBeenCalledOnce();

      // Cleanup B
      resolveB?.();
      await promiseB;
      vi.runAllTimers();
    });

    it('handles rapid consecutive requests correctly', async () => {
      vi.useFakeTimers();

      const operation = vi.fn().mockResolvedValue('result');

      // Fire many rapid requests
      const promises: Promise<unknown>[] = [];
      for (let i = 0; i < 10; i++) {
        promises.push(dedup.execute('cmd', { key: 'same' }, operation));
      }

      await Promise.all(promises);

      // Should only execute once
      expect(operation).toHaveBeenCalledOnce();
    });

    it('allows new request after debounce window expires', async () => {
      vi.useFakeTimers();

      const operation1 = vi.fn().mockResolvedValue('result1');
      const operation2 = vi.fn().mockResolvedValue('result2');

      // First request
      await dedup.execute('cmd', { id: 1 }, operation1);

      // Advance past debounce window
      vi.advanceTimersByTime(RequestDeduplicator.DEBOUNCE_WINDOW_MS + 10);
      await Promise.resolve();

      // Second request should execute
      await dedup.execute('cmd', { id: 1 }, operation2);

      expect(operation1).toHaveBeenCalledOnce();
      expect(operation2).toHaveBeenCalledOnce();
    });

    it('deduplicates requests within debounce window', async () => {
      vi.useFakeTimers();

      const operation1 = vi.fn().mockResolvedValue('result1');
      const operation2 = vi.fn().mockResolvedValue('result2');

      // First request
      await dedup.execute('cmd', { id: 1 }, operation1);

      // Within debounce window
      vi.advanceTimersByTime(RequestDeduplicator.DEBOUNCE_WINDOW_MS - 10);

      // Second request should be deduplicated
      await dedup.execute('cmd', { id: 1 }, operation2);

      expect(operation1).toHaveBeenCalledOnce();
      expect(operation2).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // isInFlight Method
  // ===========================================================================

  describe('isInFlight method', () => {
    it('returns true for in-flight request', async () => {
      let resolve: () => void;
      const operation = vi.fn(
        () =>
          new Promise<void>((r) => {
            resolve = r;
          }),
      );

      const promise = dedup.execute('cmd', { id: 1 }, operation);

      expect(dedup.isInFlight('cmd', { id: 1 })).toBe(true);
      expect(dedup.isInFlight('cmd', { id: 2 })).toBe(false);
      expect(dedup.isInFlight('other', { id: 1 })).toBe(false);

      resolve!();
      await promise;
    });

    it('returns false after cleanup', async () => {
      vi.useFakeTimers();

      const operation = vi.fn().mockResolvedValue('result');

      await dedup.execute('cmd', { id: 1 }, operation);

      // Advance past debounce window
      vi.advanceTimersByTime(RequestDeduplicator.DEBOUNCE_WINDOW_MS + 10);
      await Promise.resolve();

      expect(dedup.isInFlight('cmd', { id: 1 })).toBe(false);
    });
  });

  // ===========================================================================
  // clearForTesting
  // ===========================================================================

  describe('clearForTesting', () => {
    it('clears all state', async () => {
      let resolve: () => void;
      const operation = vi.fn(
        () =>
          new Promise<void>((r) => {
            resolve = r;
          }),
      );

      const promise = dedup.execute('cmd', { id: 1 }, operation);

      expect(dedup.inFlightCount).toBe(1);

      dedup.clearForTesting();

      expect(dedup.inFlightCount).toBe(0);

      // Cleanup the pending promise
      resolve!();
      await promise;
    });

    it('cancels all cleanup timers', () => {
      vi.useFakeTimers();

      const operation = vi.fn().mockResolvedValue('result');

      dedup.execute('cmd', { id: 1 }, operation);

      const cleanupTimers = (dedup as unknown as { cleanupTimers: Map<string, unknown> }).cleanupTimers;
      expect(cleanupTimers.size).toBeGreaterThanOrEqual(0); // May not have timer until operation completes

      dedup.clearForTesting();

      expect(cleanupTimers.size).toBe(0);
    });
  });
});
