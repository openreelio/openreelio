/**
 * Thinker Phase - Intent Analysis and Understanding
 *
 * The first phase of the agentic loop that analyzes user input
 * to understand intent, identify requirements, and determine
 * if clarification is needed.
 *
 * Responsibilities:
 * - Parse user input to understand intent
 * - Identify requirements for executing the request
 * - Detect uncertainties that need clarification
 * - Formulate approach strategy
 * - Determine if more information is needed from user
 */

import type { ILLMClient, LLMMessage } from '../ports/ILLMClient';
import type { AgentContext, Thought } from '../core/types';
import { ThinkingTimeoutError, UnderstandingError } from '../core/errors';

// =============================================================================
// Types
// =============================================================================

/**
 * Configuration for the Thinker phase
 */
export interface ThinkerConfig {
  /** Timeout for thinking operation in milliseconds */
  timeout?: number;
  /** Custom system prompt override */
  systemPromptOverride?: string;
  /** Maximum retries on transient errors */
  maxRetries?: number;
}

/**
 * Default configuration values
 */
const DEFAULT_CONFIG: Required<ThinkerConfig> = {
  timeout: 60000, // 60 seconds (structured output is slow)
  systemPromptOverride: '',
  maxRetries: 2,
};

// =============================================================================
// Thinker Class
// =============================================================================

/**
 * Thinker phase implementation
 *
 * Analyzes user input using LLM to understand intent and
 * determine the best approach for execution.
 *
 * @example
 * ```typescript
 * const thinker = createThinker(llmClient);
 * const thought = await thinker.think("Split the clip at 5 seconds", context);
 *
 * if (thought.needsMoreInfo) {
 *   // Ask user for clarification
 *   console.log(thought.clarificationQuestion);
 * } else {
 *   // Proceed to planning
 *   console.log(thought.approach);
 * }
 * ```
 */
export class Thinker {
  private readonly llm: ILLMClient;
  private readonly config: Required<ThinkerConfig>;
  private abortController: AbortController | null = null;

  constructor(llm: ILLMClient, config: ThinkerConfig = {}) {
    this.llm = llm;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ===========================================================================
  // Public Methods
  // ===========================================================================

  /**
   * Analyze user input and generate a thought
   *
   * @param input - User's natural language input
   * @param context - Current agent context
   * @param history - Optional conversation history for multi-turn context
   * @returns Structured thought with understanding, requirements, and approach
   * @throws ThinkingTimeoutError if operation times out
   * @throws UnderstandingError if LLM fails or returns invalid response
   */
  async think(input: string, context: AgentContext, history?: LLMMessage[]): Promise<Thought> {
    this.abortController = new AbortController();

    const messages = this.buildMessages(input, context, history);
    const schema = this.buildThoughtSchema();

    try {
      const thought = await this.executeWithTimeout(
        () => this.llm.generateStructured<Thought>(messages, schema),
        this.config.timeout
      );

      this.validateThought(thought);
      return thought;
    } catch (error) {
      if (error instanceof ThinkingTimeoutError) {
        throw error;
      }
      if (error instanceof UnderstandingError) {
        throw error;
      }
      throw new UnderstandingError(
        `Failed to analyze input: ${error instanceof Error ? error.message : String(error)}`,
        { originalError: error }
      );
    } finally {
      this.abortController = null;
    }
  }

  /**
   * Analyze user input with streaming progress updates
   *
   * @param input - User's natural language input
   * @param context - Current agent context
   * @param onProgress - Callback for progress updates
   * @returns Structured thought
   */
  async thinkWithStreaming(
    input: string,
    context: AgentContext,
    onProgress: (chunk: string) => void,
    history?: LLMMessage[]
  ): Promise<Thought> {
    this.abortController = new AbortController();

    const messages = this.buildMessages(input, context, history);

    try {
      // First, stream the thinking process for UI feedback
      for await (const chunk of this.llm.generateStream(messages)) {
        if (this.abortController?.signal.aborted) {
          break;
        }
        onProgress(chunk);
      }

      // Then get the structured result
      const schema = this.buildThoughtSchema();
      const thought = await this.llm.generateStructured<Thought>(
        messages,
        schema
      );

      this.validateThought(thought);
      return thought;
    } catch (error) {
      throw new UnderstandingError(
        `Failed to analyze input with streaming: ${error instanceof Error ? error.message : String(error)}`,
        { originalError: error }
      );
    } finally {
      this.abortController = null;
    }
  }

  /**
   * Abort ongoing thinking operation
   */
  abort(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.llm.abort();
    }
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  /**
   * Build messages for LLM including system prompt, optional history, and user input
   */
  private buildMessages(input: string, context: AgentContext, history?: LLMMessage[]): LLMMessage[] {
    const systemPrompt = this.buildSystemPrompt(context);
    const messages: LLMMessage[] = [
      { role: 'system', content: systemPrompt },
    ];

    // Insert conversation history between system prompt and current input
    if (history && history.length > 0) {
      messages.push(...history);
    }

    messages.push({ role: 'user', content: input });
    return messages;
  }

  /**
   * Build system prompt with context information
   */
  private buildSystemPrompt(context: AgentContext): string {
    if (this.config.systemPromptOverride) {
      return this.config.systemPromptOverride;
    }

    const parts: string[] = [
      'You are an AI assistant for a video editing application.',
      'Your task is to analyze the user\'s request and understand their intent.',
      '',
      'Current Context:',
    ];

    // Add selected clips
    if (context.selectedClips.length > 0) {
      parts.push(`- Selected clips: ${context.selectedClips.join(', ')}`);
    }

    // Add playhead position
    if (context.playheadPosition !== undefined) {
      parts.push(`- Playhead position: ${context.playheadPosition} seconds`);
    }

    // Add available tools
    if (context.availableTools.length > 0) {
      parts.push(`- Available tools: ${context.availableTools.join(', ')}`);
    }

    // Add timeline info if available
    if (context.timelineInfo) {
      parts.push(`- Timeline duration: ${context.timelineInfo.duration} seconds`);
      parts.push(`- Track count: ${context.timelineInfo.trackCount}`);
    }

    parts.push('');
    parts.push('Analyze the user\'s request and provide:');
    parts.push('1. Your understanding of what they want to do');
    parts.push('2. Requirements needed to fulfill the request');
    parts.push('3. Any uncertainties that need clarification');
    parts.push('4. Your proposed approach');
    parts.push('5. Whether you need more information from the user');

    return parts.join('\n');
  }

  /**
   * Build JSON schema for structured thought output
   */
  private buildThoughtSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        understanding: {
          type: 'string',
          description: 'Clear description of what the user wants to accomplish',
        },
        requirements: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of requirements needed to fulfill the request',
        },
        uncertainties: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of unclear aspects that may need clarification',
        },
        approach: {
          type: 'string',
          description: 'Proposed approach to fulfill the request',
        },
        needsMoreInfo: {
          type: 'boolean',
          description: 'Whether clarification is needed from the user',
        },
        clarificationQuestion: {
          type: 'string',
          description: 'Question to ask user if needsMoreInfo is true',
        },
      },
      required: [
        'understanding',
        'requirements',
        'uncertainties',
        'approach',
        'needsMoreInfo',
      ],
    };
  }

  /**
   * Execute operation with timeout
   */
  private async executeWithTimeout<T>(
    operation: () => Promise<T>,
    timeout: number
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.abort();
        reject(new ThinkingTimeoutError(timeout));
      }, timeout);

      const abortHandler = () => {
        clearTimeout(timeoutId);
        reject(new ThinkingTimeoutError(timeout));
      };

      // Check if already aborted
      if (this.abortController?.signal.aborted) {
        clearTimeout(timeoutId);
        reject(new ThinkingTimeoutError(timeout));
        return;
      }

      const signal = this.abortController?.signal;
      if (signal) {
        signal.addEventListener('abort', abortHandler);
      }

      const cleanup = () => {
        if (signal) {
          signal.removeEventListener('abort', abortHandler);
        }
      };

      operation()
        .then((result) => {
          clearTimeout(timeoutId);
          cleanup();
          resolve(result);
        })
        .catch((error) => {
          clearTimeout(timeoutId);
          cleanup();
          reject(error);
        });
    });
  }

  /**
   * Validate that thought has all required fields
   */
  private validateThought(thought: unknown): asserts thought is Thought {
    if (!thought || typeof thought !== 'object') {
      throw new UnderstandingError('Invalid thought: not an object');
    }

    const t = thought as Record<string, unknown>;

    if (typeof t.understanding !== 'string') {
      throw new UnderstandingError('Invalid thought: missing understanding');
    }

    if (!Array.isArray(t.requirements)) {
      throw new UnderstandingError('Invalid thought: requirements not an array');
    }

    if (!Array.isArray(t.uncertainties)) {
      throw new UnderstandingError('Invalid thought: uncertainties not an array');
    }

    if (typeof t.approach !== 'string') {
      throw new UnderstandingError('Invalid thought: missing approach');
    }

    if (typeof t.needsMoreInfo !== 'boolean') {
      throw new UnderstandingError('Invalid thought: needsMoreInfo not boolean');
    }

    // If needs more info, must have clarification question
    if (t.needsMoreInfo && typeof t.clarificationQuestion !== 'string') {
      throw new UnderstandingError(
        'Invalid thought: needsMoreInfo true but no clarificationQuestion'
      );
    }
  }
}

// =============================================================================
// Factory Functions
// =============================================================================

/**
 * Create a new Thinker instance
 *
 * @param llm - LLM client for generating thoughts
 * @param config - Optional configuration
 * @returns Configured Thinker instance
 */
export function createThinker(
  llm: ILLMClient,
  config?: ThinkerConfig
): Thinker {
  return new Thinker(llm, config);
}
