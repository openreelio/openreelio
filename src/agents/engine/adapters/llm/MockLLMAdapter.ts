/**
 * MockLLMAdapter - Mock LLM Client for Testing
 *
 * Provides controllable responses for unit testing.
 * Simulates LLM behavior without actual API calls.
 */

import type {
  ILLMClient,
  LLMMessage,
  GenerateOptions,
  LLMToolDefinition,
  LLMStreamEvent,
  LLMCompletionResult,
} from '../../ports/ILLMClient';

// =============================================================================
// Types
// =============================================================================

/**
 * Configuration for mock responses
 */
export interface MockResponse {
  /** Text content to return */
  content?: string;
  /** Tool calls to return */
  toolCalls?: Array<{
    id: string;
    name: string;
    args: Record<string, unknown>;
  }>;
  /** Structured output to return */
  structured?: unknown;
  /** Error to throw */
  error?: Error;
  /** Delay before response (ms) */
  delay?: number;
  /** Chunk size for streaming */
  chunkSize?: number;
}

/**
 * Request capture for verification
 */
export interface CapturedRequest {
  type: 'stream' | 'tools' | 'structured' | 'complete';
  messages: LLMMessage[];
  tools?: LLMToolDefinition[];
  schema?: Record<string, unknown>;
  options?: GenerateOptions;
  timestamp: number;
}

// =============================================================================
// MockLLMAdapter
// =============================================================================

/**
 * Mock LLM adapter for testing
 *
 * Features:
 * - Configurable responses per method
 * - Request capture for verification
 * - Simulated streaming
 * - Error simulation
 *
 * @example
 * ```typescript
 * const mock = new MockLLMAdapter();
 *
 * // Configure response
 * mock.setStreamResponse({ content: 'Hello world' });
 *
 * // Use in test
 * for await (const chunk of mock.generateStream(messages)) {
 *   console.log(chunk);
 * }
 *
 * // Verify
 * expect(mock.getLastRequest()?.messages).toEqual(messages);
 * ```
 */
export class MockLLMAdapter implements ILLMClient {
  readonly provider = 'mock';

  private _isGenerating = false;
  private _isConfigured = true;
  private _aborted = false;

  private streamResponse: MockResponse = { content: '' };
  private toolsResponse: MockResponse = { content: '' };
  private structuredResponse: MockResponse = { structured: {} };
  private completeResponse: MockResponse = { content: '' };

  private capturedRequests: CapturedRequest[] = [];

  // ===========================================================================
  // Configuration
  // ===========================================================================

  /**
   * Set response for generateStream
   */
  setStreamResponse(response: MockResponse): void {
    this.streamResponse = response;
  }

  /**
   * Set response for generateWithTools
   */
  setToolsResponse(response: MockResponse): void {
    this.toolsResponse = response;
  }

  /**
   * Set response for generateStructured
   */
  setStructuredResponse(response: MockResponse): void {
    this.structuredResponse = response;
  }

  /**
   * Set response for complete
   */
  setCompleteResponse(response: MockResponse): void {
    this.completeResponse = response;
  }

  /**
   * Set whether client is configured
   */
  setConfigured(configured: boolean): void {
    this._isConfigured = configured;
  }

  /**
   * Reset all responses and captured requests
   */
  reset(): void {
    this.streamResponse = { content: '' };
    this.toolsResponse = { content: '' };
    this.structuredResponse = { structured: {} };
    this.completeResponse = { content: '' };
    this.capturedRequests = [];
    this._aborted = false;
    this._isGenerating = false;
  }

  // ===========================================================================
  // Request Verification
  // ===========================================================================

  /**
   * Get all captured requests
   */
  getCapturedRequests(): CapturedRequest[] {
    return [...this.capturedRequests];
  }

  /**
   * Get the last captured request
   */
  getLastRequest(): CapturedRequest | undefined {
    return this.capturedRequests[this.capturedRequests.length - 1];
  }

  /**
   * Get request count
   */
  getRequestCount(): number {
    return this.capturedRequests.length;
  }

  /**
   * Clear captured requests
   */
  clearRequests(): void {
    this.capturedRequests = [];
  }

  // ===========================================================================
  // ILLMClient Implementation
  // ===========================================================================

  async *generateStream(
    messages: LLMMessage[],
    options?: GenerateOptions
  ): AsyncGenerator<string, void, unknown> {
    this.captureRequest('stream', messages, undefined, undefined, options);

    if (this.streamResponse.error) {
      throw this.streamResponse.error;
    }

    this._isGenerating = true;
    this._aborted = false;

    try {
      if (this.streamResponse.delay) {
        await this.delay(this.streamResponse.delay);
      }

      const content = this.streamResponse.content ?? '';
      const chunkSize = this.streamResponse.chunkSize ?? 10;

      for (let i = 0; i < content.length; i += chunkSize) {
        if (this._aborted) {
          return;
        }

        const chunk = content.slice(i, i + chunkSize);
        yield chunk;

        // Small delay to simulate streaming
        await this.delay(1);
      }
    } finally {
      this._isGenerating = false;
    }
  }

  async *generateWithTools(
    messages: LLMMessage[],
    tools: LLMToolDefinition[],
    options?: GenerateOptions
  ): AsyncGenerator<LLMStreamEvent, void, unknown> {
    this.captureRequest('tools', messages, tools, undefined, options);

    if (this.toolsResponse.error) {
      yield { type: 'error', error: this.toolsResponse.error };
      return;
    }

    this._isGenerating = true;
    this._aborted = false;

    try {
      if (this.toolsResponse.delay) {
        await this.delay(this.toolsResponse.delay);
      }

      // Emit text content if present
      if (this.toolsResponse.content) {
        const chunkSize = this.toolsResponse.chunkSize ?? 10;
        const content = this.toolsResponse.content;

        for (let i = 0; i < content.length; i += chunkSize) {
          if (this._aborted) {
            return;
          }

          yield { type: 'text', content: content.slice(i, i + chunkSize) };
          await this.delay(1);
        }
      }

      // Emit tool calls if present
      if (this.toolsResponse.toolCalls) {
        for (const toolCall of this.toolsResponse.toolCalls) {
          if (this._aborted) {
            return;
          }

          yield {
            type: 'tool_call',
            id: toolCall.id,
            name: toolCall.name,
            args: toolCall.args,
          };
        }
      }

      yield { type: 'done' };
    } finally {
      this._isGenerating = false;
    }
  }

  async generateStructured<T>(
    messages: LLMMessage[],
    schema: Record<string, unknown>,
    options?: GenerateOptions
  ): Promise<T> {
    this.captureRequest('structured', messages, undefined, schema, options);

    if (this.structuredResponse.error) {
      throw this.structuredResponse.error;
    }

    if (this.structuredResponse.delay) {
      await this.delay(this.structuredResponse.delay);
    }

    return this.structuredResponse.structured as T;
  }

  async complete(
    messages: LLMMessage[],
    options?: GenerateOptions
  ): Promise<LLMCompletionResult> {
    this.captureRequest('complete', messages, undefined, undefined, options);

    if (this.completeResponse.error) {
      throw this.completeResponse.error;
    }

    if (this.completeResponse.delay) {
      await this.delay(this.completeResponse.delay);
    }

    return {
      content: this.completeResponse.content ?? '',
      finishReason: this.completeResponse.toolCalls ? 'tool_call' : 'stop',
      toolCalls: this.completeResponse.toolCalls,
    };
  }

  abort(): void {
    this._aborted = true;
    this._isGenerating = false;
  }

  isGenerating(): boolean {
    return this._isGenerating;
  }

  isConfigured(): boolean {
    return this._isConfigured;
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  private captureRequest(
    type: CapturedRequest['type'],
    messages: LLMMessage[],
    tools?: LLMToolDefinition[],
    schema?: Record<string, unknown>,
    options?: GenerateOptions
  ): void {
    this.capturedRequests.push({
      type,
      messages: [...messages],
      tools: tools ? [...tools] : undefined,
      schema,
      options,
      timestamp: Date.now(),
    });
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// =============================================================================
// Factory
// =============================================================================

/**
 * Create a mock LLM adapter with default configuration
 */
export function createMockLLMAdapter(): MockLLMAdapter {
  return new MockLLMAdapter();
}

/**
 * Create a mock LLM adapter with preset responses
 */
export function createMockLLMAdapterWithResponses(responses: {
  stream?: MockResponse;
  tools?: MockResponse;
  structured?: MockResponse;
  complete?: MockResponse;
}): MockLLMAdapter {
  const adapter = new MockLLMAdapter();

  if (responses.stream) {
    adapter.setStreamResponse(responses.stream);
  }
  if (responses.tools) {
    adapter.setToolsResponse(responses.tools);
  }
  if (responses.structured) {
    adapter.setStructuredResponse(responses.structured);
  }
  if (responses.complete) {
    adapter.setCompleteResponse(responses.complete);
  }

  return adapter;
}
