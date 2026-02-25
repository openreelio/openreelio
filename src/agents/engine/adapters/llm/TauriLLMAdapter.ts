/**
 * TauriLLMAdapter - Tauri Backend LLM Adapter
 *
 * Bridges the ILLMClient interface to the Tauri backend AI gateway.
 * Uses the existing backend infrastructure for API calls, ensuring
 * secure API key handling and consistent provider configuration.
 *
 * Streaming methods use real Tauri event-based streaming via
 * `listen()` from `@tauri-apps/api/event`. The backend command
 * `stream_ai_completion` emits incremental events that are
 * converted to the ILLMClient async generator contract.
 *
 * Non-streaming methods (`complete`, `generateStructured`) continue
 * to use `invoke()` for request-response semantics.
 */

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
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
 * Events emitted by the `stream_ai_completion` backend command.
 *
 * Each event is delivered via Tauri's event system on channel
 * `ai_stream_{streamId}`.
 */
type BackendStreamEvent =
  | { type: 'textDelta'; content: string }
  | { type: 'reasoningDelta'; content: string }
  | { type: 'toolCallStart'; id: string; name: string }
  | { type: 'toolCallDelta'; id: string; argsChunk: string }
  | { type: 'toolCallComplete'; id: string; name: string; argsJson: string }
  | { type: 'usage'; inputTokens: number; outputTokens: number }
  | { type: 'error'; message: string }
  | { type: 'done'; finishReason: string };

/**
 * Internal result from {@link TauriLLMAdapter.createStreamChannel}.
 */
interface StreamChannel {
  /** Async generator that yields backend stream events as they arrive. */
  events: AsyncGenerator<BackendStreamEvent, void, unknown>;
  /** Unsubscribes the Tauri event listener and terminates the generator. */
  cleanup: () => void;
}

/** Internal state for assembling streamed tool calls. */
interface PendingToolCall {
  name: string;
  argsChunks: string[];
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
}

/**
 * Default configuration
 */
const DEFAULT_CONFIG: Required<TauriLLMAdapterConfig> = {
  defaultContext: {},
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
 * Streaming methods (`generateStream`, `generateWithTools`) use real
 * Tauri event-based streaming. The backend emits incremental events
 * on a per-request channel, which this adapter converts to the
 * `AsyncGenerator` contract defined by `ILLMClient`.
 *
 * @example
 * ```typescript
 * const adapter = createTauriLLMAdapter();
 *
 * // Real streaming
 * for await (const chunk of adapter.generateStream([
 *   { role: 'user', content: 'Hello' }
 * ])) {
 *   process.stdout.write(chunk);
 * }
 *
 * // Non-streaming
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

  /** Stream ID of the currently active streaming request (for abort). */
  private activeStreamId: string | null = null;

  /** Cleanup function for the currently active stream channel. */
  private activeStreamCleanup: (() => void) | null = null;

  constructor(config: TauriLLMAdapterConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ===========================================================================
  // ILLMClient Implementation
  // ===========================================================================

  /**
   * Generate text with real Tauri event-based streaming.
   *
   * Starts the backend `stream_ai_completion` command and yields
   * text deltas as they arrive via Tauri events.
   *
   * @param messages - Conversation messages
   * @param options - Generation options
   * @yields String chunks as they are generated by the backend
   */
  async *generateStream(
    messages: LLMMessage[],
    options?: GenerateOptions,
  ): AsyncGenerator<string, void, unknown> {
    const requestId = this.beginRequest();
    const streamId = crypto.randomUUID();
    this.activeStreamId = streamId;

    try {
      // For streaming, the system prompt is passed as a separate IPC
      // parameter to stream_ai_completion. Do NOT inject it into messages
      // to avoid the backend receiving it twice.
      const backendMessages = this.convertMessages(messages);

      // Subscribe first to avoid dropping early error/done events.
      const { events, cleanup } = await this.createStreamChannel(streamId);
      this.activeStreamCleanup = cleanup;

      try {
        // Start backend stream after listener is active.
        await this.invokeStream(streamId, backendMessages, options);

        for await (const event of events) {
          if (this._aborted) {
            break;
          }

          switch (event.type) {
            case 'textDelta':
              yield event.content;
              break;
            case 'error':
              throw new Error(event.message);
            case 'done':
              // Stream completed normally
              break;
            default:
              // Ignore reasoning deltas, tool events, and usage in text-only mode
              break;
          }
        }
      } finally {
        cleanup();
      }
    } finally {
      this.activeStreamId = null;
      this.activeStreamCleanup = null;
      this.finishRequest(requestId);
    }
  }

  /**
   * Generate with tool support using real Tauri event-based streaming.
   *
   * Starts the backend `stream_ai_completion` command and yields
   * `LLMStreamEvent` values as tool calls and text arrive via
   * Tauri events.
   *
   * @param messages - Conversation messages
   * @param tools - Available tool definitions
   * @param options - Generation options
   * @yields Stream events (text, tool calls, done, error)
   */
  async *generateWithTools(
    messages: LLMMessage[],
    tools: LLMToolDefinition[],
    options?: GenerateOptions,
  ): AsyncGenerator<LLMStreamEvent, void, unknown> {
    const requestId = this.beginRequest();
    const streamId = crypto.randomUUID();
    this.activeStreamId = streamId;

    try {
      const backendMessages = this.convertMessages(messages, options);

      // Subscribe first to avoid dropping early error/done events.
      const { events, cleanup } = await this.createStreamChannel(streamId);
      this.activeStreamCleanup = cleanup;

      /** Accumulates usage data from a 'usage' event for the final 'done'. */
      let lastUsage: { inputTokens: number; outputTokens: number } | undefined;
      const pendingToolCalls = new Map<string, PendingToolCall>();

      try {
        // Start backend stream after listener is active.
        try {
          await this.invokeStream(streamId, backendMessages, options, tools);
        } catch (error) {
          yield {
            type: 'error',
            error: error instanceof Error ? error : new Error(String(error)),
          };
          return;
        }

        for await (const event of events) {
          if (this._aborted) {
            break;
          }

          switch (event.type) {
            case 'textDelta':
              yield { type: 'text', content: event.content };
              break;

            case 'toolCallComplete': {
              pendingToolCalls.delete(event.id);
              yield {
                type: 'tool_call',
                id: event.id,
                name: event.name,
                args: this.parseToolArgs(event.argsJson),
              };
              break;
            }

            case 'toolCallStart': {
              const existing = pendingToolCalls.get(event.id);
              if (existing) {
                existing.name = event.name;
              } else {
                pendingToolCalls.set(event.id, {
                  name: event.name,
                  argsChunks: [],
                });
              }
              break;
            }

            case 'toolCallDelta': {
              const existing = pendingToolCalls.get(event.id);
              if (existing) {
                existing.argsChunks.push(event.argsChunk);
              } else {
                pendingToolCalls.set(event.id, {
                  name: event.id,
                  argsChunks: [event.argsChunk],
                });
              }
              break;
            }

            case 'usage':
              lastUsage = {
                inputTokens: event.inputTokens,
                outputTokens: event.outputTokens,
              };
              break;

            case 'done':
              for (const [id, pending] of pendingToolCalls) {
                yield {
                  type: 'tool_call',
                  id,
                  name: pending.name,
                  args: this.parseToolArgs(pending.argsChunks.join('')),
                };
              }
              pendingToolCalls.clear();
              yield { type: 'done', usage: lastUsage };
              break;

            case 'error':
              pendingToolCalls.clear();
              yield {
                type: 'error',
                error: new Error(event.message),
              };
              break;

            case 'reasoningDelta':
              yield { type: 'reasoning', content: event.content };
              break;

            default:
              break;
          }
        }
      } finally {
        cleanup();
      }
    } finally {
      this.activeStreamId = null;
      this.activeStreamCleanup = null;
      this.finishRequest(requestId);
    }
  }

  /**
   * Generate structured output.
   *
   * Expects the backend to return JSON in the message field.
   * Uses the non-streaming `complete_with_ai_raw` command.
   *
   * When the response is truncated (finishReason is 'max_tokens' or
   * 'length'), the adapter attempts to repair the JSON before failing.
   *
   * @param messages - Conversation messages
   * @param schema - JSON Schema for the expected output
   * @param options - Generation options
   * @returns Parsed object matching schema
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

      const truncated =
        response.finishReason === 'max_tokens' || response.finishReason === 'length';

      if (truncated) {
        console.warn(
          `[TauriLLMAdapter] Structured response truncated ` +
            `(finishReason=${response.finishReason}, ` +
            `completionTokens=${response.usage.completionTokens}). ` +
            `Attempting JSON repair.`,
        );
      }

      return this.parseStructuredResponse<T>(response.text, truncated);
    } finally {
      this.finishRequest(requestId);
    }
  }

  /**
   * Non-streaming completion.
   *
   * Uses the existing `chat_with_ai` backend command for
   * request-response semantics.
   *
   * @param messages - Conversation messages
   * @param options - Generation options
   * @returns Complete response with content and optional tool calls
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
   * Abort ongoing generation.
   *
   * For streaming requests, also notifies the backend to stop
   * emitting events for the active stream.
   */
  abort(): void {
    this._aborted = true;
    this._isGenerating = false;
    this.abortController?.abort();

    // Terminate the active stream channel so the generator unblocks
    if (this.activeStreamCleanup) {
      this.activeStreamCleanup();
      this.activeStreamCleanup = null;
    }

    // Notify the backend to stop the active stream
    if (this.activeStreamId) {
      invoke('abort_ai_stream', { streamId: this.activeStreamId }).catch(() => {
        // Best-effort; the backend may not support this command yet
      });
      this.activeStreamId = null;
    }
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
   * Refresh provider status from backend.
   *
   * Queries `get_ai_provider_status` and, if not configured, falls
   * back to `sync_ai_from_vault` to auto-configure from the OS
   * credential store.
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
  // Streaming Infrastructure
  // ===========================================================================

  /**
   * Create a streaming event channel for a given stream ID.
   *
   * Subscribes to the Tauri event `ai_stream_{streamId}` and
   * returns an async generator that yields `BackendStreamEvent`
   * values as they arrive. The generator terminates when a
   * `done` or `error` event is received, or when `cleanup()` is
   * called.
   *
   * @param streamId - Unique identifier for the streaming session
   * @returns An object with the event generator and a cleanup function
   */
  private async createStreamChannel(streamId: string): Promise<StreamChannel> {
    const queue: BackendStreamEvent[] = [];
    let resolve: (() => void) | null = null;
    let done = false;

    const unlisten: UnlistenFn = await listen<BackendStreamEvent>(
      `ai_stream_${streamId}`,
      (event) => {
        queue.push(event.payload);
        if (resolve) {
          resolve();
          resolve = null;
        }
      },
    );

    async function* eventGenerator(): AsyncGenerator<BackendStreamEvent, void, unknown> {
      while (!done) {
        // Drain all queued events
        while (queue.length > 0) {
          const streamEvent = queue.shift()!;
          if (streamEvent.type === 'done' || streamEvent.type === 'error') {
            done = true;
          }
          yield streamEvent;
          if (done) {
            return;
          }
        }

        // If done was set externally (e.g. by cleanup/abort) while the
        // generator was paused at a yield, exit before blocking on the
        // promise.
        if (done) {
          return;
        }

        // Wait for the next event to arrive
        await new Promise<void>((r) => {
          resolve = r;
          // If cleanup/abort ran between the yield and here, `done` is
          // already true but `resolve` was null at that time, so the
          // promise was never resolved.  Resolve it immediately.
          if (done) {
            resolve = null;
            r();
          }
        });
      }
    }

    const cleanup = (): void => {
      done = true;
      unlisten();
      // Unblock the generator if it is waiting for the next event
      if (resolve) {
        resolve();
        resolve = null;
      }
    };

    return { events: eventGenerator(), cleanup };
  }

  /**
   * Invoke the backend `stream_ai_completion` command.
   *
   * This returns once the backend stream task has started.
   * Stream payloads arrive asynchronously via Tauri events on
   * `ai_stream_{streamId}`.
   *
   * @param streamId - Unique stream session ID
   * @param messages - Converted backend messages
   * @param options - Generation options
   * @param tools - Optional tool definitions for tool-enabled generation
   */
  private invokeStream(
    streamId: string,
    messages: TauriConversationMessage[],
    options?: GenerateOptions,
    tools?: LLMToolDefinition[],
  ): Promise<void> {
    return invoke('stream_ai_completion', {
      streamId,
      messages,
      systemPrompt: options?.systemPrompt ?? null,
      options: {
        maxTokens: options?.maxTokens ?? null,
        temperature: options?.temperature ?? null,
        model: null,
        jsonMode: false,
      },
      tools: tools ?? null,
    });
  }

  private parseToolArgs(argsJson: string): Record<string, unknown> {
    if (!argsJson.trim()) {
      return {};
    }

    try {
      const parsed = JSON.parse(argsJson) as unknown;
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      return {};
    } catch {
      return {};
    }
  }

  // ===========================================================================
  // Backend Communication (Non-Streaming)
  // ===========================================================================

  /**
   * Call the backend `chat_with_ai` command (non-streaming).
   *
   * Used by `complete()` for request-response semantics.
   */
  private async callBackend(
    messages: LLMMessage[],
    options?: GenerateOptions,
  ): Promise<TauriAIResponse> {
    if (this._aborted) {
      throw new Error('Generation aborted');
    }

    const backendMessages = this.convertMessages(messages, options);

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

  /**
   * Call the backend `complete_with_ai_raw` command (non-streaming).
   *
   * Used by `generateStructured()` for JSON-mode completions.
   */
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

  // ===========================================================================
  // Message Conversion
  // ===========================================================================

  /**
   * Convert frontend `LLMMessage[]` to backend `TauriConversationMessage[]`.
   *
   * Handles system prompt injection: if `options.systemPrompt` is
   * provided and no system message exists, one is prepended. If a
   * system message already exists, the system prompt is prepended
   * to its content.
   */
  private convertMessages(
    messages: LLMMessage[],
    options?: GenerateOptions,
  ): TauriConversationMessage[] {
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

    return backendMessages;
  }

  // ===========================================================================
  // Response Validation
  // ===========================================================================

  /**
   * Validate `chat_with_ai` response shape at runtime.
   *
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
      needsConfirmation:
        typeof record.needsConfirmation === 'boolean' ? record.needsConfirmation : undefined,
      intent:
        typeof record.intent === 'object' && record.intent !== null
          ? (record.intent as TauriAIResponse['intent'])
          : undefined,
    };
  }

  /**
   * Validate `complete_with_ai_raw` response shape at runtime.
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
      usage:
        typeof record.usage === 'object' && record.usage !== null
          ? (record.usage as TauriRawCompletionResponse['usage'])
          : { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      finishReason: typeof record.finishReason === 'string' ? record.finishReason : 'unknown',
    };
  }

  // ===========================================================================
  // Structured Response Parsing
  // ===========================================================================

  /**
   * Parse a raw text response as structured JSON.
   *
   * Attempts multiple extraction strategies in order:
   * 1. Raw text
   * 2. Code-fenced JSON blocks
   * 3. Embedded balanced JSON objects/arrays
   * 4. (If truncated) Repaired JSON — closes unterminated strings,
   *    arrays, and objects so partial results can still be used.
   *
   * @param rawText - The raw LLM output text
   * @param truncated - Whether the response was truncated by the provider
   */
  private parseStructuredResponse<T>(rawText: string, truncated = false): T {
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

    // Strategy 4: Attempt JSON repair on the raw text (useful when
    // the response was truncated mid-string or mid-object).
    const repaired = this.repairTruncatedJson(text);
    if (repaired !== null) {
      candidates.add(repaired);
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
    const truncatedHint = truncated ? ' (response was truncated by token limit)' : '';
    throw new Error(
      `Failed to parse structured response${truncatedHint}: ${preview}...: ${lastErrorMessage}`,
    );
  }

  /** Extract JSON candidates from markdown code fences. */
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

  /** Extract embedded JSON candidates by finding balanced braces/brackets. */
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

  /** Extract a balanced JSON object or array from the given position. */
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

  // ===========================================================================
  // JSON Repair
  // ===========================================================================

  /**
   * Attempt to repair a truncated JSON string.
   *
   * When an LLM response is cut off mid-output (due to token limits),
   * the JSON is syntactically invalid. This method walks the text,
   * tracking string/object/array nesting, then appends the minimal
   * closing tokens needed to make the JSON parseable.
   *
   * Limitations:
   * - Repaired JSON may be missing fields that the schema requires
   *   (the caller's validation layer handles that).
   * - Truncation inside a numeric literal or keyword (true/false/null)
   *   cannot be repaired reliably and will return null.
   *
   * @returns A repaired JSON string, or null if repair is not feasible.
   */
  repairTruncatedJson(text: string): string | null {
    const jsonStart = text.indexOf('{');
    if (jsonStart < 0) {
      return null;
    }

    const source = text.slice(jsonStart);
    const closingStack: string[] = [];
    let inString = false;
    let escaped = false;

    for (let i = 0; i < source.length; i += 1) {
      const char = source[i];

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
        if (closingStack.length > 0 && closingStack[closingStack.length - 1] === char) {
          closingStack.pop();
        }
      }
    }

    // Already balanced — nothing to repair
    if (!inString && closingStack.length === 0) {
      return null;
    }

    let repaired = source;

    // Close an unterminated string
    if (inString) {
      repaired += '"';
    }

    // Strip a trailing comma that would make the JSON invalid
    // (common when truncated after a list element)
    repaired = repaired.replace(/,\s*$/, '');

    // Close all open containers in reverse order
    while (closingStack.length > 0) {
      repaired += closingStack.pop();
    }

    return repaired;
  }

  // ===========================================================================
  // Request Lifecycle
  // ===========================================================================

  /**
   * Begin a new request. Resets abort state and tracks the request.
   * @returns A unique request ID for this request
   */
  private beginRequest(): number {
    this._isGenerating = true;
    this._aborted = false;
    this.abortController = new AbortController();
    const requestId = ++this.requestSequence;
    this.activeRequestId = requestId;
    return requestId;
  }

  /**
   * Finish a request. Only clears state if this is still the active request.
   * @param requestId - The request ID returned by {@link beginRequest}
   */
  private finishRequest(requestId: number): void {
    if (this.activeRequestId !== requestId) {
      return;
    }

    this._isGenerating = false;
    this.abortController = null;
    this.activeRequestId = null;
  }
}

// =============================================================================
// Factory Functions
// =============================================================================

/**
 * Create a TauriLLMAdapter instance
 *
 * @param config - Optional configuration
 * @returns A new TauriLLMAdapter
 */
export function createTauriLLMAdapter(config?: TauriLLMAdapterConfig): TauriLLMAdapter {
  return new TauriLLMAdapter(config);
}
