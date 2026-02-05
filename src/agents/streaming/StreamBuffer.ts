/**
 * StreamBuffer
 *
 * A buffer for handling chunked streaming AI responses.
 * Provides state management, event emission, and content accumulation.
 */

import { createLogger } from '@/services/logger';

const logger = createLogger('StreamBuffer');

// =============================================================================
// Types
// =============================================================================

/** Possible states of the stream buffer */
export type StreamBufferState =
  | 'idle'
  | 'streaming'
  | 'complete'
  | 'aborted'
  | 'error';

/** A chunk of streamed content */
export interface StreamChunk {
  /** The content of the chunk */
  content: string;
  /** The index of this chunk in the stream */
  index: number;
  /** Optional timestamp when chunk was received */
  timestamp?: number;
  /** Optional metadata */
  metadata?: Record<string, unknown>;
}

/** Configuration for the stream buffer */
export interface StreamBufferConfig {
  /** Maximum buffer size in bytes before flush (default: 1MB) */
  maxBufferSize?: number;
  /** Threshold for triggering flush event (default: 80% of max) */
  flushThreshold?: number;
}

/** Statistics about the buffer */
export interface StreamBufferStatistics {
  /** Number of chunks received */
  chunkCount: number;
  /** Total bytes in buffer */
  totalBytes: number;
  /** Current state */
  state: StreamBufferState;
  /** Start time if streaming */
  startTime?: number;
  /** Duration in milliseconds */
  duration?: number;
}

/** Event types for the stream buffer */
export type StreamBufferEventType =
  | 'start'
  | 'chunk'
  | 'complete'
  | 'abort'
  | 'error'
  | 'flush';

/** Event listener function */
export type StreamBufferEventListener<T = unknown> = (data: T) => void;

/** Unsubscribe function */
export type Unsubscribe = () => void;

// =============================================================================
// StreamBuffer Implementation
// =============================================================================

/**
 * Buffer for handling streaming AI responses.
 *
 * Features:
 * - State management (idle, streaming, complete, aborted, error)
 * - Event emission for state changes and chunks
 * - Content accumulation with statistics
 * - Buffer size limits with flush notifications
 */
export class StreamBuffer {
  private state: StreamBufferState = 'idle';
  private content: string = '';
  private chunkCount: number = 0;
  private error: Error | null = null;
  private startTime: number | null = null;

  private readonly maxBufferSize: number;
  private readonly flushThreshold: number;

  private listeners: Map<
    StreamBufferEventType,
    Set<StreamBufferEventListener>
  > = new Map();

  constructor(config?: StreamBufferConfig) {
    this.maxBufferSize = config?.maxBufferSize ?? 1024 * 1024; // 1MB default
    this.flushThreshold =
      config?.flushThreshold ?? Math.floor(this.maxBufferSize * 0.8);

    // Initialize listener maps
    this.listeners.set('start', new Set());
    this.listeners.set('chunk', new Set());
    this.listeners.set('complete', new Set());
    this.listeners.set('abort', new Set());
    this.listeners.set('error', new Set());
    this.listeners.set('flush', new Set());
  }

  // ===========================================================================
  // State Getters
  // ===========================================================================

  /** Get current buffer state */
  getState(): StreamBufferState {
    return this.state;
  }

  /** Get accumulated content */
  getContent(): string {
    return this.content;
  }

  /** Get number of chunks received */
  getChunkCount(): number {
    return this.chunkCount;
  }

  /** Get error if any */
  getError(): Error | null {
    return this.error;
  }

  /** Get buffer statistics */
  getStatistics(): StreamBufferStatistics {
    const now = Date.now();
    return {
      chunkCount: this.chunkCount,
      totalBytes: this.content.length,
      state: this.state,
      startTime: this.startTime ?? undefined,
      duration: this.startTime ? now - this.startTime : undefined,
    };
  }

  // ===========================================================================
  // State Transitions
  // ===========================================================================

  /**
   * Start streaming.
   * Transitions from idle to streaming state.
   */
  start(): void {
    if (this.state === 'streaming') {
      throw new Error('Buffer already streaming');
    }

    this.state = 'streaming';
    this.content = '';
    this.chunkCount = 0;
    this.error = null;
    this.startTime = Date.now();

    this.emit('start', undefined);
    logger.debug('Stream buffer started');
  }

  /**
   * Append a chunk to the buffer.
   * Only valid when in streaming state.
   *
   * @param chunk - The chunk to append
   */
  append(chunk: StreamChunk): void {
    if (this.state !== 'streaming') {
      throw new Error('Buffer not in streaming state');
    }

    this.content += chunk.content;
    this.chunkCount++;

    this.emit('chunk', chunk);

    // Check if we should emit flush event
    if (this.content.length >= this.flushThreshold) {
      this.emit('flush', {
        content: this.content,
        size: this.content.length,
      });
    }
  }

  /**
   * Complete the stream successfully.
   * Transitions from streaming to complete state.
   */
  complete(): void {
    if (this.state !== 'streaming') {
      throw new Error('Buffer not in streaming state');
    }

    this.state = 'complete';
    this.emit('complete', this.content);
    logger.debug('Stream buffer completed', {
      chunkCount: this.chunkCount,
      contentLength: this.content.length,
    });
  }

  /**
   * Abort the stream.
   * Transitions from streaming to aborted state.
   *
   * @param reason - Optional reason for abort
   */
  abort(reason?: string): void {
    if (this.state !== 'streaming') {
      return; // Silently ignore if not streaming
    }

    this.state = 'aborted';
    this.emit('abort', reason ?? 'Aborted');
    logger.debug('Stream buffer aborted', { reason });
  }

  /**
   * Mark the stream as errored.
   * Transitions to error state.
   *
   * @param err - The error that occurred
   */
  setError(err: Error): void {
    this.state = 'error';
    this.error = err;
    this.emit('error', err);
    logger.error('Stream buffer error', { error: err.message });
  }

  /**
   * Reset the buffer to initial state.
   */
  reset(): void {
    this.state = 'idle';
    this.content = '';
    this.chunkCount = 0;
    this.error = null;
    this.startTime = null;
    logger.debug('Stream buffer reset');
  }

  // ===========================================================================
  // Event Handling
  // ===========================================================================

  /**
   * Add an event listener.
   *
   * @param event - The event type
   * @param listener - The listener function
   * @returns Unsubscribe function
   */
  on<T = unknown>(
    event: StreamBufferEventType,
    listener: StreamBufferEventListener<T>
  ): Unsubscribe {
    const listeners = this.listeners.get(event);
    if (listeners) {
      listeners.add(listener as StreamBufferEventListener);
    }

    return () => {
      this.off(event, listener);
    };
  }

  /**
   * Remove an event listener.
   *
   * @param event - The event type
   * @param listener - The listener function to remove
   */
  off<T = unknown>(
    event: StreamBufferEventType,
    listener: StreamBufferEventListener<T>
  ): void {
    const listeners = this.listeners.get(event);
    if (listeners) {
      listeners.delete(listener as StreamBufferEventListener);
    }
  }

  /**
   * Emit an event to all listeners.
   */
  private emit<T>(event: StreamBufferEventType, data: T): void {
    const listeners = this.listeners.get(event);
    if (listeners) {
      for (const listener of listeners) {
        try {
          listener(data);
        } catch (err) {
          logger.error('Error in stream buffer event listener', {
            event,
            error: err,
          });
        }
      }
    }
  }
}
