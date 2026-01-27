/**
 * CommandQueue - Async Operation Serializer
 *
 * Ensures all async operations execute sequentially to prevent race conditions.
 * This is critical for data integrity in the editor.
 *
 * Features:
 * - FIFO queue with single concurrent execution
 * - Automatic error recovery (queue continues after failure)
 * - Timeout protection with proper operation cancellation via AbortController
 * - Backpressure protection with max queue size to prevent memory exhaustion
 * - Queue inspection methods for debugging
 *
 * @example
 * ```typescript
 * const queue = new CommandQueue();
 * const result = await queue.enqueue(async (signal) => {
 *   // Check signal.aborted periodically or pass to fetch/etc
 *   return await someAsyncOperation({ signal });
 * }, 'myOperation');
 * ```
 */

import { createLogger } from '@/services/logger';

const logger = createLogger('CommandQueue');

/**
 * Cancellable operation type - receives AbortSignal for cancellation support
 */
export type CancellableOperation<T> = (signal: AbortSignal) => Promise<T>;

/**
 * Queue item structure for pending operations
 */
interface QueueItem {
  operation: () => Promise<void>;
  operationName: string;
  abortController: AbortController;
}

/**
 * Queue status for debugging and monitoring
 */
export interface QueueStatus {
  /** Name of the currently executing operation, if any */
  currentOperation: string | null;
  /** Names of pending operations in queue order */
  pendingOperations: string[];
  /** Total count of operations (current + pending) */
  totalCount: number;
  /** Whether the queue is actively processing */
  isProcessing: boolean;
}

/**
 * CommandQueue ensures all async operations execute sequentially to prevent
 * race conditions. This is critical for data integrity in the editor.
 *
 * Design:
 * - FIFO queue with single concurrent execution
 * - Automatic error recovery (queue continues after failure)
 * - Timeout protection with AbortController for proper cancellation
 * - Backpressure protection with max queue size to prevent memory exhaustion
 * - Queue inspection for debugging stuck operations
 */
export class CommandQueue {
  private queue: QueueItem[] = [];
  private isProcessing = false;
  private currentOperationName: string | null = null;

  /** Operation timeout in milliseconds */
  private static readonly OPERATION_TIMEOUT_MS = 30000;

  /** Maximum queue size to prevent memory exhaustion under heavy load */
  private static readonly MAX_QUEUE_SIZE = 100;

  /**
   * Enqueues an operation for sequential execution with cancellation support.
   *
   * The operation receives an AbortSignal that will be aborted on timeout.
   * Operations should check signal.aborted or pass the signal to fetch/etc.
   *
   * @param operation - Async operation to execute (receives AbortSignal)
   * @param operationName - Name for logging/debugging (default: 'unknown')
   * @returns Promise that resolves with the operation result
   * @throws Error if queue is full (backpressure protection)
   * @throws Error if operation times out (with AbortError)
   */
  async enqueue<T>(
    operation: CancellableOperation<T> | (() => Promise<T>),
    operationName = 'unknown',
  ): Promise<T> {
    // Backpressure protection: reject if queue is full
    if (this.queue.length >= CommandQueue.MAX_QUEUE_SIZE) {
      const errorMessage = `Command queue is full (${this.queue.length} pending operations). Please wait for current operations to complete.`;
      logger.error('Queue backpressure triggered', {
        operationName,
        queueSize: this.queue.length,
        maxSize: CommandQueue.MAX_QUEUE_SIZE,
      });
      throw new Error(errorMessage);
    }

    const abortController = new AbortController();

    return new Promise<T>((resolve, reject) => {
      const wrappedOperation = async (): Promise<void> => {
        const { signal } = abortController;

        // Setup timeout that aborts the operation
        const timeoutId = setTimeout(() => {
          logger.error('Operation timeout - aborting', { operationName });
          abortController.abort(new Error(`Operation timeout: ${operationName}`));
        }, CommandQueue.OPERATION_TIMEOUT_MS);

        try {
          // Check if already aborted before starting
          if (signal.aborted) {
            throw signal.reason instanceof Error
              ? signal.reason
              : new Error(`Operation aborted: ${operationName}`);
          }

          // Pass signal to operation if it accepts it, otherwise call without
          const result = await operation(signal);

          // Check if aborted during execution
          if (signal.aborted) {
            throw signal.reason instanceof Error
              ? signal.reason
              : new Error(`Operation aborted: ${operationName}`);
          }

          clearTimeout(timeoutId);
          resolve(result);
        } catch (error) {
          clearTimeout(timeoutId);

          // Wrap abort errors for clarity
          if (signal.aborted) {
            const abortError =
              signal.reason instanceof Error
                ? signal.reason
                : new Error(`Operation aborted: ${operationName}`);
            reject(abortError);
          } else {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        }
      };

      this.queue.push({
        operation: wrappedOperation,
        operationName,
        abortController,
      });

      void this.processQueue();
    });
  }

  /**
   * Processes queued operations sequentially.
   * Called automatically after enqueue.
   */
  private async processQueue(): Promise<void> {
    if (this.isProcessing || this.queue.length === 0) {
      return;
    }

    this.isProcessing = true;

    while (this.queue.length > 0) {
      const item = this.queue.shift();
      if (!item) break;

      this.currentOperationName = item.operationName;

      try {
        await item.operation();
      } catch (error) {
        logger.error('Queue operation failed', {
          operationName: item.operationName,
          error: error instanceof Error ? error.message : String(error),
          wasAborted: item.abortController.signal.aborted,
        });
        // Continue processing queue even after failure
      }

      this.currentOperationName = null;
    }

    this.isProcessing = false;
  }

  /**
   * Returns the number of pending operations in the queue.
   */
  get pendingCount(): number {
    return this.queue.length;
  }

  /**
   * Returns detailed queue status for debugging.
   */
  getStatus(): QueueStatus {
    return {
      currentOperation: this.currentOperationName,
      pendingOperations: this.queue.map((item) => item.operationName),
      totalCount: (this.currentOperationName ? 1 : 0) + this.queue.length,
      isProcessing: this.isProcessing,
    };
  }

  /**
   * Clears all pending operations from the queue and aborts them.
   * Currently executing operation will continue but pending ones are aborted.
   */
  clear(): void {
    const count = this.queue.length;
    // Abort all pending operations
    for (const item of this.queue) {
      item.abortController.abort(new Error('Queue cleared'));
    }
    this.queue.splice(0);
    if (count > 0) {
      logger.debug('Queue cleared', { abortedCount: count });
    }
  }

  /**
   * Cancels a specific pending operation by name.
   * Returns true if operation was found and cancelled.
   */
  cancelOperation(operationName: string): boolean {
    const index = this.queue.findIndex((item) => item.operationName === operationName);
    if (index >= 0) {
      const item = this.queue[index];
      item.abortController.abort(new Error(`Operation cancelled: ${operationName}`));
      this.queue.splice(index, 1);
      logger.debug('Operation cancelled', { operationName });
      return true;
    }
    return false;
  }
}

/**
 * Global command queue instance for serializing project operations.
 * Used by projectStore to ensure sequential command execution.
 */
export const commandQueue = new CommandQueue();

/**
 * Resets the command queue state.
 * FOR TESTING ONLY - do not use in production code.
 */
export function _resetCommandQueueForTesting(): void {
  commandQueue.clear();
}
