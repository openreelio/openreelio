/**
 * RequestDeduplicator - Duplicate Request Prevention
 *
 * Tracks in-flight requests to prevent duplicate operations from double-clicks
 * or rapid repeated invocations. Uses a hash of command type + payload.
 *
 * Features:
 * - Prevents duplicate operations during rapid invocations
 * - Configurable debounce window for duplicate detection
 * - Automatic cleanup of tracked requests after completion
 * - Memory-safe with bounded cleanup timer tracking
 *
 * @example
 * ```typescript
 * const dedup = new RequestDeduplicator();
 * const result = await dedup.execute('saveFile', { path }, async () => {
 *   return await saveFile(path);
 * });
 * ```
 */

import { createLogger } from '@/services/logger';

const logger = createLogger('RequestDeduplicator');

/**
 * Tracks in-flight requests to prevent duplicate operations from double-clicks
 * or rapid repeated invocations. Uses a simple hash of command type + payload.
 */
export class RequestDeduplicator {
  private inFlight = new Map<string, Promise<unknown>>();
  private cleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /** Time window for considering requests as duplicates */
  private static readonly DEBOUNCE_WINDOW_MS = 100;

  /** Maximum number of tracked requests to prevent memory exhaustion */
  private static readonly MAX_TRACKED_REQUESTS = 1000;

  /**
   * Generates a unique key for the request based on type and payload.
   *
   * @param commandType - Type/name of the command
   * @param payload - Command payload for hashing
   * @returns Unique key string
   */
  private generateKey(commandType: string, payload: unknown): string {
    try {
      return `${commandType}:${JSON.stringify(payload)}`;
    } catch {
      // If payload is not serializable, use only command type with timestamp bucket
      const bucket = Math.floor(Date.now() / RequestDeduplicator.DEBOUNCE_WINDOW_MS);
      return `${commandType}:${bucket}`;
    }
  }

  /**
   * Cleans up a specific key from tracking.
   * Cancels any pending cleanup timer before removing.
   */
  private cleanup(key: string): void {
    const timer = this.cleanupTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.cleanupTimers.delete(key);
    }
    this.inFlight.delete(key);
  }

  /**
   * Schedules cleanup for a key after the debounce window.
   * Any existing timer for the key is cancelled first.
   */
  private scheduleCleanup(key: string): void {
    // Cancel existing timer if any
    const existingTimer = this.cleanupTimers.get(key);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    // Schedule new cleanup
    const timer = setTimeout(() => {
      this.cleanupTimers.delete(key);
      this.inFlight.delete(key);
    }, RequestDeduplicator.DEBOUNCE_WINDOW_MS);

    this.cleanupTimers.set(key, timer);
  }

  /**
   * Executes operation with deduplication. If an identical request is already
   * in flight, returns the same promise instead of starting a new operation.
   *
   * @param commandType - Type/name of the command for deduplication key
   * @param payload - Command payload for deduplication key
   * @param operation - Async operation to execute
   * @returns Promise that resolves with the operation result
   */
  async execute<T>(commandType: string, payload: unknown, operation: () => Promise<T>): Promise<T> {
    const key = this.generateKey(commandType, payload);

    // Check if an identical request is already in flight
    const existing = this.inFlight.get(key);
    if (existing) {
      logger.debug('Deduplicating request', { commandType, key });
      return existing as Promise<T>;
    }

    // Prevent memory exhaustion under extreme load
    if (this.inFlight.size >= RequestDeduplicator.MAX_TRACKED_REQUESTS) {
      logger.warn('Request deduplicator at capacity, clearing old entries', {
        size: this.inFlight.size,
      });
      // Clear oldest half of entries
      const keysToRemove = Array.from(this.inFlight.keys()).slice(
        0,
        Math.floor(this.inFlight.size / 2),
      );
      for (const oldKey of keysToRemove) {
        this.cleanup(oldKey);
      }
    }

    // Execute the operation and track it
    const promise = operation().finally(() => {
      // Schedule cleanup after debounce window to catch rapid duplicates
      this.scheduleCleanup(key);
    });

    this.inFlight.set(key, promise);
    return promise;
  }

  /**
   * Returns the number of in-flight requests (useful for debugging).
   */
  get inFlightCount(): number {
    return this.inFlight.size;
  }

  /**
   * Clears all tracked in-flight requests and cancels all pending timers.
   * FOR TESTING ONLY - do not call from production code.
   */
  clearForTesting(): void {
    // Cancel all pending cleanup timers
    for (const timer of this.cleanupTimers.values()) {
      clearTimeout(timer);
    }
    this.cleanupTimers.clear();
    this.inFlight.clear();
  }
}

/**
 * Global deduplicator instance for preventing duplicate project operations.
 * Used by projectStore to prevent double-click issues.
 */
export const requestDeduplicator = new RequestDeduplicator();

/**
 * Resets the request deduplicator state.
 * FOR TESTING ONLY - do not use in production code.
 */
export function _resetDeduplicatorForTesting(): void {
  requestDeduplicator.clearForTesting();
}
