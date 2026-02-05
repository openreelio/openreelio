/**
 * TauriLLMAdapter - Tauri Backend LLM Adapter
 *
 * Bridges the ILLMClient interface to the Tauri backend AI gateway.
 * Uses the existing backend infrastructure for API calls, ensuring
 * secure API key handling and consistent provider configuration.
 *
 * Note: True streaming is not supported by the backend yet.
 * This adapter simulates streaming by chunking the response.
 */

import { invoke } from '@tauri-apps/api/core';
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
 * Context sent to the backend
 */
interface TauriAIContext {
  playhead_position: number;
  selected_clips: string[];
  selected_tracks: string[];
  timeline_duration?: number;
  asset_ids: string[];
  track_ids: string[];
}

/**
 * Message format for backend
 */
interface TauriConversationMessage {
  role: string;
  content: string;
}

/**
 * Response from backend chat_with_ai
 */
interface TauriAIResponse {
  message: string;
  actions?: Array<{
    commandType: string;
    params: Record<string, unknown>;
    description?: string;
  }> | null;
  needsConfirmation?: boolean;
  intent?: {
    intentType: string;
    confidence: number;
  } | null;
}

/**
 * Response from complete_with_ai_raw
 */
interface TauriRawCompletionResponse {
  text: string;
  model: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  finishReason: string;
}

/**
 * Provider status from backend
 */
interface TauriProviderStatus {
  providerType: string | null;
  isConfigured: boolean;
  isAvailable: boolean;
  currentModel: string | null;
  availableModels: string[];
  errorMessage: string | null;
}

/**
 * Configuration for TauriLLMAdapter
 */
export interface TauriLLMAdapterConfig {
  /** Default context to use for requests */
  defaultContext?: Partial<{
    playheadPosition: number;
    selectedClips: string[];
    selectedTracks: string[];
    timelineDuration: number;
    assetIds: string[];
    trackIds: string[];
  }>;
  /** Chunk size for simulated streaming */
  streamChunkSize?: number;
  /** Delay between chunks for simulated streaming (ms) */
  streamChunkDelay?: number;
}

/**
 * Default configuration
 */
const DEFAULT_CONFIG: Required<TauriLLMAdapterConfig> = {
  defaultContext: {},
  streamChunkSize: 20,
  streamChunkDelay: 10,
};

// =============================================================================
// TauriLLMAdapter
// =============================================================================

/**
 * LLM Adapter that uses the Tauri backend AI gateway.
 *
 * This adapter bridges the frontend agentic engine to the existing
 * Rust backend, which handles actual API calls to providers.
 *
 * @example
 * ```typescript
 * const adapter = createTauriLLMAdapter();
 *
 * const result = await adapter.complete([
 *   { role: 'user', content: 'Hello' }
 * ]);
 * console.log(result.content);
 * ```
 */
export class TauriLLMAdapter implements ILLMClient {
  readonly provider = 'tauri';

  private config: Required<TauriLLMAdapterConfig>;
  private _isGenerating = false;
  private _isConfigured = false;
  private _aborted = false;
  private abortController: AbortController | null = null;

  constructor(config: TauriLLMAdapterConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ===========================================================================
  // ILLMClient Implementation
  // ===========================================================================

  /**
   * Generate text with simulated streaming
   *
   * Since the backend doesn't support true streaming, we fetch the
   * complete response and then yield it in chunks.
   */
  async *generateStream(
    messages: LLMMessage[],
    options?: GenerateOptions
  ): AsyncGenerator<string, void, unknown> {
    this._isGenerating = true;
    this._aborted = false;
    this.abortController = new AbortController();

    try {
      const response = await this.callBackend(messages, options);

      if (this._aborted) {
        return;
      }

      const content = response.message;
      const chunkSize = this.config.streamChunkSize;

      // Simulate streaming by yielding chunks
      for (let i = 0; i < content.length; i += chunkSize) {
        if (this._aborted) {
          return;
        }

        yield content.slice(i, i + chunkSize);

        // Small delay to simulate streaming
        await this.delay(this.config.streamChunkDelay);
      }
    } finally {
      this._isGenerating = false;
      this.abortController = null;
    }
  }

  /**
   * Generate with tool support
   */
  async *generateWithTools(
    messages: LLMMessage[],
    _tools: LLMToolDefinition[],
    options?: GenerateOptions
  ): AsyncGenerator<LLMStreamEvent, void, unknown> {
    this._isGenerating = true;
    this._aborted = false;
    this.abortController = new AbortController();

    try {
      const response = await this.callBackend(messages, options);

      if (this._aborted) {
        return;
      }

      // Emit text content
      if (response.message) {
        yield { type: 'text', content: response.message };
      }

      // Emit tool calls if present
      if (response.actions && response.actions.length > 0) {
        for (const action of response.actions) {
          if (this._aborted) {
            return;
          }

          yield {
            type: 'tool_call',
            id: `tool_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
            name: action.commandType,
            args: action.params,
          };
        }
      }

      yield { type: 'done' };
    } catch (error) {
      yield {
        type: 'error',
        error: error instanceof Error ? error : new Error(String(error)),
      };
    } finally {
      this._isGenerating = false;
      this.abortController = null;
    }
  }

  /**
   * Generate structured output
   *
   * Expects the backend to return JSON in the message field.
   */
  async generateStructured<T>(
    messages: LLMMessage[],
    schema: Record<string, unknown>,
    options?: GenerateOptions
  ): Promise<T> {
    const schemaInstructions = [
      'Return ONLY a JSON object that strictly matches the JSON Schema.',
      'Do not include markdown code fences, comments, or additional text.',
      '',
      'JSON Schema:',
      JSON.stringify(schema),
    ].join('\n');

    const response = await this.callRawCompletion(
      [...messages, { role: 'system', content: schemaInstructions }],
      {
        ...options,
        jsonMode: true,
      }
    );

    try {
      return JSON.parse(response.text) as T;
    } catch {
      throw new Error(
        `Failed to parse structured response: ${response.text.slice(0, 100)}...`
      );
    }
  }

  /**
   * Complete without streaming
   */
  async complete(
    messages: LLMMessage[],
    options?: GenerateOptions
  ): Promise<LLMCompletionResult> {
    this._isGenerating = true;
    this._aborted = false;

    try {
      const response = await this.callBackend(messages, options);

      const hasToolCalls = response.actions && response.actions.length > 0;

      return {
        content: response.message,
        finishReason: hasToolCalls ? 'tool_call' : 'stop',
        toolCalls: hasToolCalls
          ? response.actions!.map((action, index) => ({
              id: `tool_${index}_${Date.now()}`,
              name: action.commandType,
              args: action.params,
            }))
          : undefined,
      };
    } finally {
      this._isGenerating = false;
    }
  }

  /**
   * Abort ongoing generation
   */
  abort(): void {
    this._aborted = true;
    this._isGenerating = false;
    this.abortController?.abort();
  }

  /**
   * Check if currently generating
   */
  isGenerating(): boolean {
    return this._isGenerating;
  }

  /**
   * Check if the backend provider is configured
   */
  isConfigured(): boolean {
    return this._isConfigured;
  }

  // ===========================================================================
  // Additional Methods
  // ===========================================================================

  /**
   * Refresh provider status from backend
   */
  async refreshStatus(): Promise<TauriProviderStatus> {
    try {
      const status = await invoke<TauriProviderStatus>('get_ai_provider_status');
      this._isConfigured = status.isConfigured;
      return status;
    } catch (error) {
      this._isConfigured = false;
      throw error;
    }
  }

  /**
   * Set context for requests
   */
  setDefaultContext(context: TauriLLMAdapterConfig['defaultContext']): void {
    this.config.defaultContext = context ?? {};
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  /**
   * Call the backend chat_with_ai command
   */
  private async callBackend(
    messages: LLMMessage[],
    options?: GenerateOptions
  ): Promise<TauriAIResponse> {
    // Convert messages to backend format
    const backendMessages: TauriConversationMessage[] = messages.map((m) => ({
      role: m.role,
      content: m.role === 'system' && options?.systemPrompt
        ? `${options.systemPrompt}\n\n${m.content}`
        : m.content,
    }));

    // Add system prompt as first message if not present
    if (options?.systemPrompt && !messages.some((m) => m.role === 'system')) {
      backendMessages.unshift({
        role: 'system',
        content: options.systemPrompt,
      });
    }

    // Build context
    const context: TauriAIContext = {
      playhead_position: this.config.defaultContext?.playheadPosition ?? 0,
      selected_clips: this.config.defaultContext?.selectedClips ?? [],
      selected_tracks: this.config.defaultContext?.selectedTracks ?? [],
      timeline_duration: this.config.defaultContext?.timelineDuration,
      asset_ids: this.config.defaultContext?.assetIds ?? [],
      track_ids: this.config.defaultContext?.trackIds ?? [],
    };

    // Call backend
    const response = await invoke<TauriAIResponse>('chat_with_ai', {
      messages: backendMessages,
      context,
    });

    return response;
  }

  private async callRawCompletion(
    messages: LLMMessage[],
    options?: (GenerateOptions & { jsonMode?: boolean })
  ): Promise<TauriRawCompletionResponse> {
    // Convert messages to backend DTO format
    const backendMessages: TauriConversationMessage[] = messages.map((m) => ({
      role: m.role,
      content: m.content,
    }));

    const rawOptions: Record<string, unknown> = {
      jsonMode: options?.jsonMode ?? false,
    };

    if (options?.systemPrompt) {
      rawOptions.systemPrompt = options.systemPrompt;
    }
    if (options?.maxTokens !== undefined) {
      rawOptions.maxTokens = options.maxTokens;
    }
    if (options?.temperature !== undefined) {
      rawOptions.temperature = options.temperature;
    }

    const response = await invoke<TauriRawCompletionResponse>('complete_with_ai_raw', {
      messages: backendMessages,
      options: rawOptions,
    });

    return response;
  }

  /**
   * Delay helper
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// =============================================================================
// Factory Functions
// =============================================================================

/**
 * Create a TauriLLMAdapter instance
 */
export function createTauriLLMAdapter(
  config?: TauriLLMAdapterConfig
): TauriLLMAdapter {
  return new TauriLLMAdapter(config);
}
