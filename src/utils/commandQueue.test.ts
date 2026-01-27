/**
 * CommandQueue Tests
 *
 * Tests for the CommandQueue class which handles sequential execution
 * of async operations with timeout and cancellation support.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CommandQueue, _resetCommandQueueForTesting, type QueueStatus } from './commandQueue';

describe('CommandQueue', () => {
  let queue: CommandQueue;

  beforeEach(() => {
    vi.useFakeTimers();
    queue = new CommandQueue();
  });

  afterEach(() => {
    queue.clear();
    vi.useRealTimers();
  });

  describe('enqueue', () => {
    it('should execute a single operation successfully', async () => {
      const operation = vi.fn().mockResolvedValue('result');

      const resultPromise = queue.enqueue(operation, 'test-op');
      await vi.runAllTimersAsync();

      const result = await resultPromise;
      expect(result).toBe('result');
      expect(operation).toHaveBeenCalledOnce();
    });

    it('should pass AbortSignal to the operation', async () => {
      let receivedSignal: AbortSignal | undefined;
      const operation = vi.fn().mockImplementation((signal: AbortSignal) => {
        receivedSignal = signal;
        return Promise.resolve('done');
      });

      const resultPromise = queue.enqueue(operation, 'test-op');
      await vi.runAllTimersAsync();
      await resultPromise;

      expect(receivedSignal).toBeInstanceOf(AbortSignal);
      expect(receivedSignal?.aborted).toBe(false);
    });

    it('should execute operations sequentially', async () => {
      const executionOrder: number[] = [];

      const op1 = vi.fn().mockImplementation(async () => {
        executionOrder.push(1);
        await new Promise((resolve) => setTimeout(resolve, 100));
        executionOrder.push(2);
        return 'op1';
      });

      const op2 = vi.fn().mockImplementation(async () => {
        executionOrder.push(3);
        return 'op2';
      });

      const promise1 = queue.enqueue(op1, 'op1');
      const promise2 = queue.enqueue(op2, 'op2');

      await vi.runAllTimersAsync();
      await Promise.all([promise1, promise2]);

      // op2 should not start until op1 completes
      expect(executionOrder).toEqual([1, 2, 3]);
    });

    it('should continue processing queue after operation failure', async () => {
      const op1 = vi.fn().mockRejectedValue(new Error('op1 failed'));
      const op2 = vi.fn().mockResolvedValue('op2 success');

      const promise1 = queue.enqueue(op1, 'op1').catch(() => 'caught');
      const promise2 = queue.enqueue(op2, 'op2');

      await vi.runAllTimersAsync();

      expect(await promise1).toBe('caught');
      expect(await promise2).toBe('op2 success');
    });

    it('should reject if queue is full (backpressure)', async () => {
      // Synchronous test that directly checks the backpressure limit
      const testQueue = new CommandQueue();

      // Mock the queue length to simulate full queue
      // Access private property for testing
      const queueInternal = testQueue as unknown as { queue: unknown[] };
      queueInternal.queue = new Array(100).fill({
        operation: () => Promise.resolve(),
        operationName: 'mock',
        abortController: new AbortController(),
      });

      // Should reject when queue is full
      await expect(
        testQueue.enqueue(() => Promise.resolve(), 'overflow')
      ).rejects.toThrow(/queue is full/i);
    });
  });

  describe('timeout', () => {
    it('should abort operation on timeout', async () => {
      let signalWasAborted = false;
      const slowOp = vi.fn().mockImplementation(async (signal: AbortSignal) => {
        // Simulate a long-running operation
        await new Promise((resolve, reject) => {
          const timeoutId = setTimeout(resolve, 60000);
          signal.addEventListener('abort', () => {
            clearTimeout(timeoutId);
            signalWasAborted = true;
            reject(signal.reason);
          });
        });
      });

      const resultPromise = queue.enqueue(slowOp, 'slow-op');

      // Advance time past the timeout (30 seconds)
      // Use advanceTimersByTimeAsync to properly handle all pending promises
      vi.advanceTimersByTime(31000);

      // Now await the promise rejection
      await expect(resultPromise).rejects.toThrow(/timeout/i);
      expect(signalWasAborted).toBe(true);
    });

    it('should not abort if operation completes before timeout', async () => {
      const fastOp = vi.fn().mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return 'fast result';
      });

      const resultPromise = queue.enqueue(fastOp, 'fast-op');

      // Advance just enough for the operation
      await vi.advanceTimersByTimeAsync(200);

      const result = await resultPromise;
      expect(result).toBe('fast result');
    });
  });

  describe('getStatus', () => {
    it('should return empty status when queue is idle', () => {
      const status = queue.getStatus();

      expect(status).toEqual<QueueStatus>({
        currentOperation: null,
        pendingOperations: [],
        totalCount: 0,
        isProcessing: false,
      });
    });

    it('should track current operation and pending operations', async () => {
      const slowOp = vi.fn().mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        return 'done';
      });

      // Start first operation
      queue.enqueue(slowOp, 'current-op');

      // Queue more operations
      queue.enqueue(slowOp, 'pending-1');
      queue.enqueue(slowOp, 'pending-2');

      // Let first operation start
      await vi.advanceTimersByTimeAsync(10);

      const status = queue.getStatus();

      expect(status.currentOperation).toBe('current-op');
      expect(status.pendingOperations).toEqual(['pending-1', 'pending-2']);
      expect(status.totalCount).toBe(3);
      expect(status.isProcessing).toBe(true);
    });
  });

  describe('clear', () => {
    it('should abort all pending operations', async () => {
      let firstOpResolve: ((value?: unknown) => void) | null = null;
      const slowFirstOp = vi.fn().mockImplementation(
        () =>
          new Promise((resolve) => {
            firstOpResolve = resolve;
          })
      );

      const slowOp = vi.fn().mockImplementation(
        () => new Promise(() => {}) // Never resolves
      );

      // Start first operation
      const promise1 = queue.enqueue(slowFirstOp, 'op1');

      // Queue more operations (these will be pending)
      queue.enqueue(slowOp, 'op2');
      queue.enqueue(slowOp, 'op3');

      // Let first operation start
      await vi.advanceTimersByTimeAsync(10);

      // Verify pending count before clear
      expect(queue.pendingCount).toBe(2);

      // Clear the queue (aborts pending operations)
      queue.clear();

      // Pending operations should be removed
      expect(queue.pendingCount).toBe(0);

      // Complete the first operation (which was already running)
      firstOpResolve!();

      // First operation should complete successfully since it was already running
      await expect(promise1).resolves.toBeUndefined();
    });

    it('should handle clear on empty queue', () => {
      expect(() => queue.clear()).not.toThrow();
      expect(queue.pendingCount).toBe(0);
    });
  });

  describe('cancelOperation', () => {
    it('should cancel a pending operation by name', () => {
      // Test cancel by directly manipulating queue state
      const testQueue = new CommandQueue();

      // Create mock queue items
      const abortController2 = new AbortController();
      const abortController3 = new AbortController();

      const queueInternal = testQueue as unknown as {
        queue: { operation: () => Promise<void>; operationName: string; abortController: AbortController }[];
        isProcessing: boolean;
        currentOperationName: string | null;
      };

      // Simulate queue with pending operations
      queueInternal.isProcessing = true;
      queueInternal.currentOperationName = 'op1';
      queueInternal.queue = [
        { operation: () => Promise.resolve(), operationName: 'op2-to-cancel', abortController: abortController2 },
        { operation: () => Promise.resolve(), operationName: 'op3', abortController: abortController3 },
      ];

      // Cancel the second operation (which is pending)
      const cancelled = testQueue.cancelOperation('op2-to-cancel');

      expect(cancelled).toBe(true);
      expect(testQueue.getStatus().pendingOperations).toEqual(['op3']);
      expect(abortController2.signal.aborted).toBe(true);
    });

    it('should return false if operation not found', () => {
      const result = queue.cancelOperation('non-existent');
      expect(result).toBe(false);
    });

    it('should not cancel currently executing operation', async () => {
      // Use real timers for this test
      vi.useRealTimers();

      const testQueue = new CommandQueue();
      const neverResolve = () => new Promise(() => {});

      // Start operation
      testQueue.enqueue(neverResolve, 'current-op');

      // Short delay to let it start
      await new Promise((r) => setTimeout(r, 10));

      // Try to cancel it (should fail because it's running, not in queue)
      const cancelled = testQueue.cancelOperation('current-op');

      expect(cancelled).toBe(false);

      // Clean up
      testQueue.clear();
      vi.useFakeTimers();
    });
  });

  describe('pendingCount', () => {
    it('should return correct count of pending operations', async () => {
      const slowOp = vi.fn().mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        return 'done';
      });

      expect(queue.pendingCount).toBe(0);

      queue.enqueue(slowOp, 'op1');
      // First op starts immediately, so queue is empty
      await vi.advanceTimersByTimeAsync(10);
      expect(queue.pendingCount).toBe(0);

      queue.enqueue(slowOp, 'op2');
      queue.enqueue(slowOp, 'op3');

      expect(queue.pendingCount).toBe(2);
    });
  });

  describe('global commandQueue instance', () => {
    it('should reset properly for testing', () => {
      _resetCommandQueueForTesting();
      // Should not throw
      expect(true).toBe(true);
    });
  });

  describe('error handling', () => {
    it('should wrap non-Error throws in Error object', async () => {
      const badOp = vi.fn().mockImplementation(async () => {
        throw 'string error';
      });

      const resultPromise = queue.enqueue(badOp, 'bad-op');

      // Await the rejection directly - no need for timer advancement
      // since the operation throws synchronously within the promise
      await expect(resultPromise).rejects.toThrow('string error');
    });

    it('should handle operation that checks abort signal', async () => {
      const abortAwareOp = vi.fn().mockImplementation(async (signal: AbortSignal) => {
        // Simulate work with periodic abort checks
        for (let i = 0; i < 5; i++) {
          if (signal.aborted) {
            throw signal.reason;
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        return 'completed';
      });

      const resultPromise = queue.enqueue(abortAwareOp, 'abort-aware');
      await vi.advanceTimersByTimeAsync(600);

      const result = await resultPromise;
      expect(result).toBe('completed');
    });
  });

  describe('concurrent safety', () => {
    it('should handle rapid sequential enqueues', async () => {
      const results: number[] = [];
      const makeOp = (n: number) =>
        vi.fn().mockImplementation(async () => {
          results.push(n);
          return n;
        });

      // Rapidly enqueue many operations
      const promises = Array.from({ length: 50 }, (_, i) =>
        queue.enqueue(makeOp(i), `op-${i}`)
      );

      await vi.runAllTimersAsync();
      await Promise.all(promises);

      // All should complete in order
      expect(results).toEqual(Array.from({ length: 50 }, (_, i) => i));
    });
  });
});
