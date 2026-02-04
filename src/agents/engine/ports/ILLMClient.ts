/**
 * ILLMClient - LLM Provider Interface
 *
 * Defines the contract for LLM providers (Anthropic, OpenAI, etc.)
 * This is a port in the hexagonal architecture.
 */

// =============================================================================
// Types
// =============================================================================

/**
 * Message role in the conversation
 */
export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

/**
 * A message in the LLM conversation
 */
export interface LLMMessage {
  /** Role of the message sender */
  role: MessageRole;
  /** Message content */
  content: string;
  /** Tool call ID (for tool results) */
  toolCallId?: string;
  /** Tool name (for tool results) */
  toolName?: string;
}

/**
 * Options for LLM generation
 */
export interface GenerateOptions {
  /** Temperature for sampling (0-1) */
  temperature?: number;
  /** Maximum tokens to generate */
  maxTokens?: number;
  /** Sequences that stop generation */
  stopSequences?: string[];
  /** System prompt override */
  systemPrompt?: string;
}

/**
 * Tool definition for function calling
 */
export interface LLMToolDefinition {
  /** Tool name */
  name: string;
  /** Tool description */
  description: string;
  /** JSON Schema for parameters */
  parameters: Record<string, unknown>;
}

/**
 * Events from tool-enabled generation
 */
export type LLMStreamEvent =
  | LLMTextEvent
  | LLMToolCallEvent
  | LLMToolResultEvent
  | LLMDoneEvent
  | LLMErrorEvent;

/**
 * Text chunk from stream
 */
export interface LLMTextEvent {
  type: 'text';
  content: string;
}

/**
 * Tool call request
 */
export interface LLMToolCallEvent {
  type: 'tool_call';
  id: string;
  name: string;
  args: Record<string, unknown>;
}

/**
 * Tool execution result
 */
export interface LLMToolResultEvent {
  type: 'tool_result';
  id: string;
  result: unknown;
}

/**
 * Generation complete
 */
export interface LLMDoneEvent {
  type: 'done';
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
}

/**
 * Error during generation
 */
export interface LLMErrorEvent {
  type: 'error';
  error: Error;
}

/**
 * Result of non-streaming generation
 */
export interface LLMCompletionResult {
  /** Generated content */
  content: string;
  /** Token usage */
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
  /** Finish reason */
  finishReason: 'stop' | 'max_tokens' | 'tool_call' | 'error';
  /** Tool calls if any */
  toolCalls?: Array<{
    id: string;
    name: string;
    args: Record<string, unknown>;
  }>;
}

// =============================================================================
// Interface
// =============================================================================

/**
 * LLM Client interface for provider abstraction
 *
 * Implementations:
 * - AnthropicAdapter: Claude models
 * - OpenAIAdapter: GPT models
 * - GeminiAdapter: Google models
 * - MockLLMAdapter: Testing
 */
export interface ILLMClient {
  /**
   * Provider name for logging/debugging
   */
  readonly provider: string;

  /**
   * Generate text with streaming
   *
   * @param messages - Conversation messages
   * @param options - Generation options
   * @yields String chunks as they're generated
   */
  generateStream(
    messages: LLMMessage[],
    options?: GenerateOptions
  ): AsyncGenerator<string, void, unknown>;

  /**
   * Generate with tool use support (streaming)
   *
   * @param messages - Conversation messages
   * @param tools - Available tools
   * @param options - Generation options
   * @yields Stream events (text, tool calls, etc.)
   */
  generateWithTools(
    messages: LLMMessage[],
    tools: LLMToolDefinition[],
    options?: GenerateOptions
  ): AsyncGenerator<LLMStreamEvent, void, unknown>;

  /**
   * Generate structured output matching a schema
   *
   * @param messages - Conversation messages
   * @param schema - JSON Schema for output
   * @param options - Generation options
   * @returns Parsed object matching schema
   */
  generateStructured<T>(
    messages: LLMMessage[],
    schema: Record<string, unknown>,
    options?: GenerateOptions
  ): Promise<T>;

  /**
   * Non-streaming completion
   *
   * @param messages - Conversation messages
   * @param options - Generation options
   * @returns Complete response
   */
  complete(
    messages: LLMMessage[],
    options?: GenerateOptions
  ): Promise<LLMCompletionResult>;

  /**
   * Abort any ongoing generation
   */
  abort(): void;

  /**
   * Check if currently generating
   */
  isGenerating(): boolean;

  /**
   * Check if the client is properly configured
   */
  isConfigured(): boolean;
}

// =============================================================================
// Factory Types
// =============================================================================

/**
 * Configuration for creating LLM clients
 */
export interface LLMClientConfig {
  /** Provider type */
  provider: 'anthropic' | 'openai' | 'gemini' | 'local';
  /** API key */
  apiKey?: string;
  /** Model identifier */
  model: string;
  /** Base URL override */
  baseUrl?: string;
  /** Default options */
  defaultOptions?: GenerateOptions;
}

/**
 * Factory function type for creating LLM clients
 */
export type LLMClientFactory = (config: LLMClientConfig) => ILLMClient;
