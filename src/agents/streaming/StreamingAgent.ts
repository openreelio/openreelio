/**
 * StreamingAgent
 *
 * Abstract base class for agents that support streaming responses.
 * Extends the base Agent with real-time chunk delivery.
 */

import { Agent, type AgentConfig, type AgentContext, type AgentMessage, type AgentResponse, type AgentTool, type AgentToolResult, type AgentEventType, type AgentEventListener } from '../Agent';
import { StreamBuffer } from './StreamBuffer';
import { createLogger } from '@/services/logger';

const logger = createLogger('StreamingAgent');

// =============================================================================
// Types
// =============================================================================

/** Configuration for streaming agent */
export interface StreamingAgentConfig extends AgentConfig {
  /** Buffer configuration */
  bufferConfig?: {
    maxBufferSize?: number;
    flushThreshold?: number;
  };
}

/** Response from a streaming operation */
export interface StreamingResponse {
  /** The complete accumulated content */
  content: string;
  /** Whether the stream completed successfully */
  success: boolean;
  /** Error message if failed */
  error?: string;
  /** Whether the stream was aborted */
  aborted?: boolean;
  /** Number of chunks received */
  chunkCount?: number;
  /** Duration in milliseconds */
  durationMs?: number;
}

/** Callback for receiving stream chunks */
export type StreamChunkCallback = (chunk: string) => void;

/** Extended event types for streaming agent */
export type StreamingAgentEventType =
  | AgentEventType
  | 'streamStart'
  | 'streamChunk'
  | 'streamEnd'
  | 'streamAbort';

// =============================================================================
// StreamingAgent Implementation
// =============================================================================

/**
 * Abstract base class for streaming agents.
 *
 * Subclasses must implement:
 * - generateStream(): Async generator that yields response chunks
 *
 * Features:
 * - Real-time chunk delivery via callback
 * - Abort support
 * - Event emission for stream lifecycle
 * - Buffer management
 */
export abstract class StreamingAgent extends Agent {
  private buffer: StreamBuffer;
  private _isStreaming: boolean = false;
  private abortRequested: boolean = false;
  private streamingListeners: Map<
    StreamingAgentEventType,
    Set<AgentEventListener>
  > = new Map();

  constructor(config: StreamingAgentConfig) {
    super(config);

    this.buffer = new StreamBuffer(config.bufferConfig);

    // Initialize streaming event listener maps
    this.streamingListeners.set('streamStart', new Set());
    this.streamingListeners.set('streamChunk', new Set());
    this.streamingListeners.set('streamEnd', new Set());
    this.streamingListeners.set('streamAbort', new Set());
  }

  // ===========================================================================
  // Public Methods
  // ===========================================================================

  /**
   * Check if currently streaming.
   */
  isStreaming(): boolean {
    return this._isStreaming;
  }

  /**
   * Get current buffer content.
   */
  getStreamBuffer(): string {
    return this.buffer.getContent();
  }

  /**
   * Run the agent with streaming response.
   *
   * @param input - The user's input message
   * @param context - Context for the agent
   * @param onChunk - Callback for each chunk
   * @returns The complete streaming response
   */
  async runWithStreaming(
    input: string,
    context: AgentContext,
    onChunk: StreamChunkCallback
  ): Promise<StreamingResponse> {
    // Check for concurrent streaming
    if (this._isStreaming) {
      return {
        content: '',
        success: false,
        error: 'Agent is already streaming',
      };
    }

    this._isStreaming = true;
    this.abortRequested = false;
    const startTime = Date.now();

    try {
      this.buffer.start();
      this.emitStreaming('streamStart', { input, context });

      let chunkIndex = 0;

      for await (const chunk of this.generateStream(input, context)) {
        // Check for abort
        if (this.abortRequested) {
          this.buffer.abort('User requested abort');
          this.emitStreaming('streamAbort', {
            chunkCount: chunkIndex,
            content: this.buffer.getContent(),
          });

          return {
            content: this.buffer.getContent(),
            success: false,
            aborted: true,
            chunkCount: chunkIndex,
            durationMs: Date.now() - startTime,
          };
        }

        // Append chunk to buffer
        this.buffer.append({
          content: chunk,
          index: chunkIndex,
          timestamp: Date.now(),
        });

        // Deliver chunk to callback
        onChunk(chunk);

        // Emit chunk event
        this.emitStreaming('streamChunk', {
          chunk,
          index: chunkIndex,
          totalContent: this.buffer.getContent(),
        });

        chunkIndex++;
      }

      // Complete the stream
      this.buffer.complete();

      const response: StreamingResponse = {
        content: this.buffer.getContent(),
        success: true,
        chunkCount: chunkIndex,
        durationMs: Date.now() - startTime,
      };

      this.emitStreaming('streamEnd', response);

      return response;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      this.buffer.setError(
        error instanceof Error ? error : new Error(errorMessage)
      );

      logger.error('Streaming error', { error: errorMessage });

      return {
        content: this.buffer.getContent(),
        success: false,
        error: errorMessage,
        durationMs: Date.now() - startTime,
      };
    } finally {
      this._isStreaming = false;
    }
  }

  /**
   * Abort the current stream.
   */
  abort(): void {
    if (this._isStreaming) {
      this.abortRequested = true;
      logger.debug('Abort requested for streaming agent');
    }
  }

  /**
   * Add an event listener for streaming events.
   *
   * @param event - The event type
   * @param listener - The listener function
   */
  on<T = unknown>(
    event: StreamingAgentEventType,
    listener: AgentEventListener<T>
  ): void {
    // Check if it's a streaming-specific event
    const streamingListeners = this.streamingListeners.get(
      event as StreamingAgentEventType
    );
    if (streamingListeners) {
      streamingListeners.add(listener as AgentEventListener);
      return;
    }

    // Delegate to parent for standard agent events
    super.on(event as AgentEventType, listener);
  }

  /**
   * Remove an event listener.
   *
   * @param event - The event type
   * @param listener - The listener function to remove
   */
  off<T = unknown>(
    event: StreamingAgentEventType,
    listener: AgentEventListener<T>
  ): void {
    const streamingListeners = this.streamingListeners.get(
      event as StreamingAgentEventType
    );
    if (streamingListeners) {
      streamingListeners.delete(listener as AgentEventListener);
      return;
    }

    super.off(event as AgentEventType, listener);
  }

  // ===========================================================================
  // Abstract Methods
  // ===========================================================================

  /**
   * Generate streaming response chunks.
   * Must be implemented by subclasses.
   *
   * @param input - The user's input message
   * @param context - The agent context
   * @yields Response chunks
   */
  protected abstract generateStream(
    input: string,
    context: AgentContext
  ): AsyncGenerator<string>;

  // ===========================================================================
  // Protected Methods (Inherited from Agent)
  // ===========================================================================

  /**
   * Process a message (required by Agent base class).
   * For streaming agents, this provides a non-streaming fallback.
   */
  protected async processMessage(
    message: AgentMessage,
    context: AgentContext
  ): Promise<AgentResponse> {
    // Collect all chunks for non-streaming response
    const chunks: string[] = [];

    for await (const chunk of this.generateStream(message.content, context)) {
      chunks.push(chunk);
    }

    const content = chunks.join('');

    return {
      message: {
        role: 'assistant',
        content,
      },
      toolCalls: [],
      shouldContinue: false,
    };
  }

  /**
   * Execute a tool call (required by Agent base class).
   * Default implementation returns an error.
   */
  protected async executeToolCall(
    tool: AgentTool,
    _args: Record<string, unknown>
  ): Promise<AgentToolResult> {
    return {
      success: false,
      error: `Tool execution not implemented for streaming agent: ${tool.name}`,
    };
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  /**
   * Emit a streaming event.
   */
  private emitStreaming<T>(event: StreamingAgentEventType, data: T): void {
    const listeners = this.streamingListeners.get(event);
    if (listeners) {
      for (const listener of listeners) {
        try {
          listener(data);
        } catch (err) {
          logger.error('Error in streaming event listener', { event, error: err });
        }
      }
    }
  }
}
