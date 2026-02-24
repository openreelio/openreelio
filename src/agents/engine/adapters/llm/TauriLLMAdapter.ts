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
  playheadPosition: number;
  selectedClips: string[];
  selectedTracks: string[];
  timelineDuration?: number;
  assetIds: string[];
  trackIds: string[];
  preferredLanguage?: string;
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
    preferredLanguage: string;
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
  private requestSequence = 0;
  private activeRequestId: number | null = null;

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
    options?: GenerateOptions,
  ): AsyncGenerator<string, void, unknown> {
    const requestId = this.beginRequest();

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
      this.finishRequest(requestId);
    }
  }

  /**
   * Generate with tool support
   */
  async *generateWithTools(
    messages: LLMMessage[],
    _tools: LLMToolDefinition[],
    options?: GenerateOptions,
  ): AsyncGenerator<LLMStreamEvent, void, unknown> {
    const requestId = this.beginRequest();

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
      this.finishRequest(requestId);
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
    options?: GenerateOptions,
  ): Promise<T> {
    const requestId = this.beginRequest();
    const schemaInstructions = [
      'Return ONLY a JSON object that strictly matches the JSON Schema.',
      'Do not include markdown code fences, comments, or additional text.',
      '',
      'JSON Schema:',
      JSON.stringify(schema),
    ].join('\n');

    try {
      const response = await this.callRawCompletion(
        [...messages, { role: 'system', content: schemaInstructions }],
        {
          ...options,
          jsonMode: true,
        },
      );

      return this.parseStructuredResponse<T>(response.text);
    } finally {
      this.finishRequest(requestId);
    }
  }

  /**
   * Complete without streaming
   */
  async complete(messages: LLMMessage[], options?: GenerateOptions): Promise<LLMCompletionResult> {
    const requestId = this.beginRequest();

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
      this.finishRequest(requestId);
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

      if (status.isConfigured) {
        this._isConfigured = true;
        return status;
      }

      try {
        const syncedStatus = await invoke<TauriProviderStatus>('sync_ai_from_vault');
        this._isConfigured = syncedStatus.isConfigured;
        return syncedStatus;
      } catch {
        this._isConfigured = false;
        return status;
      }
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
    options?: GenerateOptions,
  ): Promise<TauriAIResponse> {
    if (this._aborted) {
      throw new Error('Generation aborted');
    }

    // Convert messages to backend format
    const backendMessages: TauriConversationMessage[] = messages.map((m) => ({
      role: m.role,
      content:
        m.role === 'system' && options?.systemPrompt
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
      playheadPosition: this.config.defaultContext?.playheadPosition ?? 0,
      selectedClips: this.config.defaultContext?.selectedClips ?? [],
      selectedTracks: this.config.defaultContext?.selectedTracks ?? [],
      timelineDuration: this.config.defaultContext?.timelineDuration,
      assetIds: this.config.defaultContext?.assetIds ?? [],
      trackIds: this.config.defaultContext?.trackIds ?? [],
      preferredLanguage: this.config.defaultContext?.preferredLanguage,
    };

    // Call backend
    const response = await invoke<unknown>('chat_with_ai', {
      messages: backendMessages,
      context,
    });

    if (this._aborted) {
      throw new Error('Generation aborted');
    }

    return this.validateChatResponse(response);
  }

  private async callRawCompletion(
    messages: LLMMessage[],
    options?: GenerateOptions & { jsonMode?: boolean },
  ): Promise<TauriRawCompletionResponse> {
    if (this._aborted) {
      throw new Error('Generation aborted');
    }

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

    const response = await invoke<unknown>('complete_with_ai_raw', {
      messages: backendMessages,
      options: rawOptions,
    });

    if (this._aborted) {
      throw new Error('Generation aborted');
    }

    return this.validateRawCompletionResponse(response);
  }

  /**
   * Validate chat_with_ai response shape at runtime.
   * The generic `invoke<T>` only provides compile-time types; the backend
   * could return an unexpected shape after a version mismatch or bug.
   */
  private validateChatResponse(response: unknown): TauriAIResponse {
    if (typeof response !== 'object' || response === null) {
      throw new Error('Backend returned invalid chat response: expected object');
    }

    const record = response as Record<string, unknown>;

    if (typeof record.message !== 'string') {
      throw new Error(
        `Backend returned invalid chat response: "message" must be a string, got ${typeof record.message}`,
      );
    }

    return {
      message: record.message,
      actions: Array.isArray(record.actions) ? record.actions : undefined,
      needsConfirmation: typeof record.needsConfirmation === 'boolean' ? record.needsConfirmation : undefined,
      intent: typeof record.intent === 'object' && record.intent !== null ? record.intent as TauriAIResponse['intent'] : undefined,
    };
  }

  /**
   * Validate complete_with_ai_raw response shape at runtime.
   */
  private validateRawCompletionResponse(response: unknown): TauriRawCompletionResponse {
    if (typeof response !== 'object' || response === null) {
      throw new Error('Backend returned invalid raw completion response: expected object');
    }

    const record = response as Record<string, unknown>;

    if (typeof record.text !== 'string') {
      throw new Error(
        `Backend returned invalid raw completion response: "text" must be a string, got ${typeof record.text}`,
      );
    }

    return {
      text: record.text,
      model: typeof record.model === 'string' ? record.model : 'unknown',
      usage: typeof record.usage === 'object' && record.usage !== null
        ? (record.usage as TauriRawCompletionResponse['usage'])
        : { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      finishReason: typeof record.finishReason === 'string' ? record.finishReason : 'unknown',
    };
  }

  private parseStructuredResponse<T>(rawText: string): T {
    const text = rawText.replace(/^\uFEFF/, '').trim();
    const candidates = new Set<string>();

    if (text.length > 0) {
      candidates.add(text);
    }

    for (const fencedCandidate of this.extractCodeFenceJsonCandidates(text)) {
      if (fencedCandidate.trim().length > 0) {
        candidates.add(fencedCandidate.trim());
      }
    }

    for (const embeddedCandidate of this.extractEmbeddedJsonCandidates(text)) {
      if (embeddedCandidate.trim().length > 0) {
        candidates.add(embeddedCandidate.trim());
      }
    }

    let lastErrorMessage = 'no details';
    for (const candidate of candidates) {
      try {
        return JSON.parse(candidate) as T;
      } catch (error) {
        lastErrorMessage = error instanceof Error ? error.message : String(error);
      }
    }

    const preview = text.slice(0, 160).replace(/\s+/g, ' ');
    throw new Error(`Failed to parse structured response: ${preview}...: ${lastErrorMessage}`);
  }

  private extractCodeFenceJsonCandidates(text: string): string[] {
    const candidates: string[] = [];
    const fenceRegex = /```(?:json)?\s*([\s\S]*?)```/gi;

    for (const match of text.matchAll(fenceRegex)) {
      const candidate = match[1]?.trim();
      if (candidate) {
        candidates.push(candidate);
      }
    }

    return candidates;
  }

  private extractEmbeddedJsonCandidates(text: string): string[] {
    const candidates: string[] = [];
    const startIndexes = [text.indexOf('{'), text.indexOf('[')]
      .filter((index) => index >= 0)
      .sort((a, b) => a - b);

    for (const startIndex of startIndexes) {
      const candidate = this.extractBalancedJson(text, startIndex);
      if (candidate) {
        candidates.push(candidate);
      }
    }

    return candidates;
  }

  private extractBalancedJson(text: string, startIndex: number): string | null {
    const firstChar = text[startIndex];
    if (firstChar !== '{' && firstChar !== '[') {
      return null;
    }

    const closingStack: string[] = [firstChar === '{' ? '}' : ']'];
    let inString = false;
    let escaped = false;

    for (let index = startIndex + 1; index < text.length; index += 1) {
      const char = text[index];

      if (inString) {
        if (escaped) {
          escaped = false;
          continue;
        }

        if (char === '\\') {
          escaped = true;
          continue;
        }

        if (char === '"') {
          inString = false;
        }

        continue;
      }

      if (char === '"') {
        inString = true;
        continue;
      }

      if (char === '{') {
        closingStack.push('}');
        continue;
      }

      if (char === '[') {
        closingStack.push(']');
        continue;
      }

      if (char === '}' || char === ']') {
        const expectedClosing = closingStack.pop();
        if (expectedClosing !== char) {
          return null;
        }

        if (closingStack.length === 0) {
          return text.slice(startIndex, index + 1);
        }
      }
    }

    return null;
  }

  private beginRequest(): number {
    this._isGenerating = true;
    this._aborted = false;
    this.abortController = new AbortController();
    const requestId = ++this.requestSequence;
    this.activeRequestId = requestId;
    return requestId;
  }

  private finishRequest(requestId: number): void {
    if (this.activeRequestId !== requestId) {
      return;
    }

    this._isGenerating = false;
    this.abortController = null;
    this.activeRequestId = null;
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
export function createTauriLLMAdapter(config?: TauriLLMAdapterConfig): TauriLLMAdapter {
  return new TauriLLMAdapter(config);
}
