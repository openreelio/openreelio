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
 * - LRU-based eviction when capacity is reached
 * - Stable key generation for non-serializable payloads
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

/** Entry tracked for each in-flight request */
interface InFlightEntry {
  id: number;
  promise: Promise<unknown>;
  /** Timestamp when entry was created (for LRU eviction) */
  createdAt: number;
  /** Whether operation completed (success or failure) */
  completed: boolean;
}

/**
 * Tracks in-flight requests to prevent duplicate operations from double-clicks
 * or rapid repeated invocations. Uses a stable hash of command type + payload.
 */
export class RequestDeduplicator {
  private inFlight = new Map<string, InFlightEntry>();
  private cleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private nextId = 1;

  /** Counter for generating stable keys for non-serializable payloads */
  private nonSerializableCounter = 0;

  /** WeakMap to track non-serializable objects with stable IDs */
  private nonSerializableIds = new WeakMap<object, number>();

  /** Time window for considering requests as duplicates */
  static readonly DEBOUNCE_WINDOW_MS = 100;

  /** Maximum number of tracked requests to prevent memory exhaustion */
  static readonly MAX_TRACKED_REQUESTS = 1000;

  /**
   * Generates a stable unique key for the request based on type and payload.
   * For non-serializable payloads, uses a stable object identity-based key.
   *
   * @param commandType - Type/name of the command
   * @param payload - Command payload for hashing
   * @returns Unique key string
   */
  private generateKey(commandType: string, payload: unknown): string {
    // Handle null/undefined payloads
    if (payload === null || payload === undefined) {
      return `${commandType}:${String(payload)}`;
    }

    // Handle primitive types directly
    if (typeof payload !== 'object') {
      return `${commandType}:${JSON.stringify(payload)}`;
    }

    try {
      // Attempt JSON serialization for serializable objects
      return `${commandType}:${JSON.stringify(payload)}`;
    } catch {
      // For non-serializable objects (circular refs, functions, etc.),
      // use a stable ID based on object identity
      let objectId = this.nonSerializableIds.get(payload as object);
      if (objectId === undefined) {
        objectId = this.nonSerializableCounter++;
        this.nonSerializableIds.set(payload as object, objectId);
      }
      return `${commandType}:__nonserializable_${objectId}`;
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
  private scheduleCleanup(key: string, entryId: number): void {
    // Cancel existing timer if any
    const existingTimer = this.cleanupTimers.get(key);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    // Schedule new cleanup
    const timer = setTimeout(() => {
      this.cleanupTimers.delete(key);
      const current = this.inFlight.get(key);
      // If a newer request is now using the same key, do not delete it.
      if (current && current.id !== entryId) {
        return;
      }
      this.inFlight.delete(key);
    }, RequestDeduplicator.DEBOUNCE_WINDOW_MS);

    this.cleanupTimers.set(key, timer);
  }

  /**
   * Evicts oldest entries using LRU strategy.
   * Only evicts completed entries first; if still over capacity, evicts by age.
   */
  private evictOldEntries(): void {
    const entries = Array.from(this.inFlight.entries());

    // Sort by completion status first (completed entries are evicted first),
    // then by creation time (oldest first)
    entries.sort(([, a], [, b]) => {
      if (a.completed !== b.completed) {
        return a.completed ? -1 : 1; // Completed entries first
      }
      return a.createdAt - b.createdAt; // Then oldest first
    });

    // Remove oldest half
    const countToRemove = Math.floor(entries.length / 2);
    for (let i = 0; i < countToRemove; i++) {
      const [key, entry] = entries[i];
      // Log warning if evicting in-flight request
      if (!entry.completed) {
        logger.warn('Evicting in-flight request due to capacity', { key });
      }
      this.cleanup(key);
    }

    logger.warn('Request deduplicator performed LRU eviction', {
      removed: countToRemove,
      remaining: this.inFlight.size,
    });
  }

  /**
   * Executes operation with deduplication. If an identical request is already
   * in flight, returns the same promise instead of starting a new operation.
   *
   * @param commandType - Type/name of the command for deduplication key
   * @param payload - Command payload for deduplication key
   * @param operation - Async operation to execute
   * @returns Promise that resolves with the operation result
   * @throws Rethrows any error from the operation
   */
  async execute<T>(commandType: string, payload: unknown, operation: () => Promise<T>): Promise<T> {
    const key = this.generateKey(commandType, payload);

    // Check if an identical request is already in flight
    const existing = this.inFlight.get(key);
    if (existing) {
      logger.debug('Deduplicating request', { commandType, key });
      return existing.promise as Promise<T>;
    }

    // Prevent memory exhaustion under extreme load with LRU eviction
    if (this.inFlight.size >= RequestDeduplicator.MAX_TRACKED_REQUESTS) {
      this.evictOldEntries();
    }

    // Execute the operation and track it
    const entryId = this.nextId++;
    const createdAt = Date.now();

    const promise = operation()
      .then((result) => {
        // Mark as completed on success
        const entry = this.inFlight.get(key);
        if (entry && entry.id === entryId) {
          entry.completed = true;
        }
        return result;
      })
      .catch((error: unknown) => {
        // Mark as completed on failure
        const entry = this.inFlight.get(key);
        if (entry && entry.id === entryId) {
          entry.completed = true;
        }
        throw error;
      })
      .finally(() => {
        // Schedule cleanup after debounce window to catch rapid duplicates
        this.scheduleCleanup(key, entryId);
      });

    this.inFlight.set(key, { id: entryId, promise, createdAt, completed: false });
    return promise;
  }

  /**
   * Returns the number of in-flight requests (useful for debugging).
   */
  get inFlightCount(): number {
    return this.inFlight.size;
  }

  /**
   * Check if a specific command is currently in flight.
   * Useful for UI feedback (e.g., disabling buttons).
   *
   * @param commandType - Type/name of the command
   * @param payload - Command payload
   * @returns True if request is in flight
   */
  isInFlight(commandType: string, payload: unknown): boolean {
    const key = this.generateKey(commandType, payload);
    return this.inFlight.has(key);
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
    this.nextId = 1;
    this.nonSerializableCounter = 0;
    // Note: WeakMap doesn't need clearing - entries auto-GC when objects are GC'd
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
