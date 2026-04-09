/**
 * Observer Phase - Result Analysis and Feedback
 *
 * The fourth phase of the agentic loop that analyzes
 * execution results and determines next steps.
 *
 * Responsibilities:
 * - Analyze execution results
 * - Determine if goal was achieved
 * - Identify state changes
 * - Decide if another iteration is needed
 * - Generate feedback for user or next cycle
 */

import type { ILLMClient, LLMMessage } from '../ports/ILLMClient';
import type { Plan, Observation, AgentContext, LanguagePolicy } from '../core/types';
import type { ExecutionResult, StepExecutionRecord } from './Executor';
import { ObservationTimeoutError, ObservationError } from '../core/errors';

// =============================================================================
// Types
// =============================================================================

/**
 * Configuration for the Observer phase
 */
export interface ObserverConfig {
  /** Timeout for observation operation in milliseconds */
  timeout?: number;
  /** Maximum iterations before stopping */
  maxIterations?: number;
  /** Maximum retries on transient observation failures */
  maxRetries?: number;
  /** Backoff in milliseconds between retries */
  retryBackoffMs?: number;
  /** Custom system prompt override */
  systemPromptOverride?: string;
  /** Additional project prompt sections appended to the base phase prompt */
  projectPromptAddendum?: string;
}

/**
 * Default configuration values
 */
const DEFAULT_CONFIG: Required<ObserverConfig> = {
  timeout: 30000, // 30 seconds
  maxIterations: 5,
  maxRetries: 1,
  retryBackoffMs: 400,
  systemPromptOverride: '',
  projectPromptAddendum: '',
};

const MAX_RESULT_CHARS = 2000;

// =============================================================================
// Observer Class
// =============================================================================

/**
 * Observer phase implementation
 *
 * Analyzes execution results to determine success, identify
 * state changes, and decide if another iteration is needed.
 *
 * @example
 * ```typescript
 * const observer = createObserver(llmClient);
 * const observation = await observer.observe(plan, executionResult, context);
 *
 * if (observation.goalAchieved) {
 *   console.log('Success:', observation.summary);
 * } else if (observation.needsIteration) {
 *   // Start another iteration
 *   console.log('Retrying:', observation.iterationReason);
 * } else {
 *   // Failed and cannot retry
 *   console.log('Failed:', observation.summary);
 * }
 * ```
 */
export class Observer {
  private readonly llm: ILLMClient;
  private readonly config: Required<ObserverConfig>;
  private abortController: AbortController | null = null;

  constructor(llm: ILLMClient, config: ObserverConfig = {}) {
    this.llm = llm;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ===========================================================================
  // Public Methods
  // ===========================================================================

  /**
   * Observe and analyze execution results
   *
   * @param plan - The executed plan
   * @param execution - Execution result
   * @param context - Current agent context
   * @returns Observation with analysis and recommendations
   * @throws ObservationTimeoutError if operation times out
   * @throws ObservationError if analysis fails
   */
  async observe(
    plan: Plan,
    execution: ExecutionResult,
    context: AgentContext,
  ): Promise<Observation> {
    const schema = this.buildObservationSchema();

    const maxAttempts = this.config.maxRetries + 1;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      this.abortController = new AbortController();

      const messages = this.buildMessages(plan, execution, context);
      const timeoutMs = this.resolveTimeoutForAttempt(attempt);

      try {
        const observation = await this.executeWithTimeout(
          () => this.llm.generateStructured<Observation>(messages, schema),
          timeoutMs,
        );

        this.validateObservation(observation);
        return this.applyIterationLimit(observation, context);
      } catch (error) {
        const aborted =
          !(error instanceof ObservationTimeoutError) &&
          (this.abortController?.signal.aborted ?? false);
        const shouldRetry = this.shouldRetryObservation(error, aborted, attempt, maxAttempts);

        if (shouldRetry) {
          await this.delay(
            this.config.retryBackoffMs * (attempt + 1),
            this.abortController?.signal,
          );
          continue;
        }

        if (error instanceof ObservationTimeoutError) {
          throw error;
        }
        if (error instanceof ObservationError) {
          throw error;
        }
        throw new ObservationError(
          `Failed to analyze execution: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        this.abortController = null;
      }
    }

    throw new ObservationError('Failed to analyze execution');
  }

  /**
   * Observe with streaming progress updates
   *
   * @param plan - The executed plan
   * @param execution - Execution result
   * @param context - Current agent context
   * @param onProgress - Callback for progress updates
   * @returns Observation with analysis and recommendations
   */
  async observeWithStreaming(
    plan: Plan,
    execution: ExecutionResult,
    context: AgentContext,
    onProgress: (chunk: string) => void,
  ): Promise<Observation> {
    this.abortController = new AbortController();

    const messages = this.buildMessages(plan, execution, context);

    try {
      // Stream the analysis process for UI feedback
      for await (const chunk of this.llm.generateStream(messages)) {
        if (this.abortController?.signal.aborted) {
          break;
        }
        onProgress(chunk);
      }

      // Check abort before making additional LLM call
      if (this.abortController?.signal.aborted) {
        throw new ObservationError('Observation aborted');
      }

      // Get the structured result
      const schema = this.buildObservationSchema();
      const observation = await this.llm.generateStructured<Observation>(messages, schema);

      this.validateObservation(observation);
      return this.applyIterationLimit(observation, context);
    } catch (error) {
      throw new ObservationError(
        `Failed to analyze execution with streaming: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.abortController = null;
    }
  }

  /**
   * Abort ongoing observation
   */
  abort(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.llm.abort();
    }
  }

  // ===========================================================================
  // Private Methods - Message Building
  // ===========================================================================

  /**
   * Build messages for LLM including execution context
   */
  private buildMessages(
    plan: Plan,
    execution: ExecutionResult,
    context: AgentContext,
  ): LLMMessage[] {
    const systemPrompt = this.buildSystemPrompt(context);
    const userPrompt = this.buildUserPrompt(plan, execution, context);

    return [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ];
  }

  /**
   * Build system prompt for observation
   */
  private buildSystemPrompt(context: AgentContext): string {
    if (this.config.systemPromptOverride) {
      return this.config.systemPromptOverride;
    }

    const languageSection = this.buildLanguagePolicySection(context.languagePolicy);
    const projectPromptAddendum = this.config.projectPromptAddendum
      ? `\n\n${this.config.projectPromptAddendum}`
      : '';

    return `You are an AI observer for a video editing application.
Your task is to analyze the results of an executed plan and determine:

1. Whether the original goal was achieved
2. What state changes occurred
3. Whether another iteration is needed
4. A summary of what happened

Guidelines:
- Be precise about what succeeded and what failed
- Identify all state changes that occurred
- Only recommend iteration if there's a reasonable chance of success
- Include specific reasons for any recommendations
- Assign confidence based on how certain you are of the outcome

Confidence Scale:
- 0.9-1.0: Very confident, clear success or failure
- 0.7-0.9: Confident, most evidence points to conclusion
- 0.5-0.7: Uncertain, mixed results
- 0.0-0.5: Low confidence, unclear outcome

${languageSection}${projectPromptAddendum}`;
  }

  private buildLanguagePolicySection(languagePolicy?: LanguagePolicy): string {
    if (!languagePolicy) {
      return "Language Policy: Use the user's preferred language for natural-language fields.";
    }

    return [
      'Language Policy:',
      `- UI language: ${languagePolicy.uiLanguage}`,
      `- Default output language: ${languagePolicy.outputLanguage}`,
      `- Detect input language: ${languagePolicy.detectInputLanguage ? 'enabled' : 'disabled'}`,
      `- User language override: ${languagePolicy.allowUserLanguageOverride ? 'allowed' : 'disallowed'}`,
      '- Keep summary, iterationReason, and suggestedAction in the default output language unless user explicitly asks otherwise.',
      '- Never translate IDs, tool names, command names, or JSON keys.',
    ].join('\n');
  }

  /**
   * Build user prompt with execution details
   */
  private buildUserPrompt(plan: Plan, execution: ExecutionResult, context: AgentContext): string {
    const parts: string[] = [
      '## Original Goal',
      plan.goal,
      '',
      '## Planned Steps',
      ...plan.steps.map((s, i) => `${i + 1}. [${s.id}] ${s.tool}: ${s.description}`),
      '',
      '## Execution Summary',
      `Overall Success: ${execution.success}`,
      `Total Duration: ${execution.totalDuration}ms`,
      `Aborted: ${execution.aborted}`,
      '',
    ];

    if (execution.completedSteps.length > 0) {
      parts.push('## Completed Steps');
      for (const step of execution.completedSteps) {
        parts.push(this.formatStepResult(step, 'SUCCESS'));
      }
      parts.push('');
    }

    if (execution.failedSteps.length > 0) {
      parts.push('## Failed Steps');
      for (const step of execution.failedSteps) {
        parts.push(this.formatStepResult(step, 'FAILED'));
      }
      parts.push('');
    }

    parts.push('## Context');
    parts.push(`Current Iteration: ${context.currentIteration ?? 0}`);
    parts.push(`Max Iterations: ${this.config.maxIterations}`);

    parts.push('');
    parts.push('Analyze the execution and provide your observation.');

    return parts.join('\n');
  }

  /**
   * Format a step result for the prompt
   */
  private formatStepResult(step: StepExecutionRecord, status: 'SUCCESS' | 'FAILED'): string {
    const lines = [
      `- [${status}] ${step.stepId}: ${step.tool}`,
      `  Duration: ${step.endTime - step.startTime}ms`,
      `  Retries: ${step.retryCount}`,
    ];

    if (step.result.data) {
      lines.push(`  Result: ${this.serializeResultData(step.result.data)}`);
    }

    if (step.result.error) {
      lines.push(`  Error: ${step.result.error}`);
    }

    return lines.join('\n');
  }

  /**
   * Build JSON schema for structured observation output
   */
  private buildObservationSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        goalAchieved: {
          type: 'boolean',
          description: 'Whether the original goal was fully achieved',
        },
        stateChanges: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              type: {
                type: 'string',
                description: 'Type of change (e.g., clip_created, clip_modified)',
              },
              target: {
                type: 'string',
                description: 'ID of the affected entity',
              },
              details: {
                type: 'object',
                description: 'Additional details about the change',
              },
            },
            required: ['type', 'target'],
          },
          description: 'List of state changes that occurred',
        },
        summary: {
          type: 'string',
          description: 'Human-readable summary of what happened',
        },
        confidence: {
          type: 'number',
          minimum: 0,
          maximum: 1,
          description: 'Confidence level in the observation (0-1)',
        },
        needsIteration: {
          type: 'boolean',
          description: 'Whether another iteration is recommended',
        },
        iterationReason: {
          type: 'string',
          description: 'Reason for recommending iteration (if needsIteration)',
        },
        suggestedAction: {
          type: 'string',
          description: 'Suggested action for next iteration (if needsIteration)',
        },
      },
      required: ['goalAchieved', 'stateChanges', 'summary', 'confidence', 'needsIteration'],
    };
  }

  // ===========================================================================
  // Private Methods - Validation
  // ===========================================================================

  /**
   * Validate the observation has all required fields
   */
  private validateObservation(observation: unknown): asserts observation is Observation {
    if (!observation || typeof observation !== 'object') {
      throw new ObservationError('Invalid observation: not an object');
    }

    const o = observation as Record<string, unknown>;

    if (typeof o.goalAchieved !== 'boolean') {
      throw new ObservationError('Invalid observation: missing goalAchieved');
    }

    if (!Array.isArray(o.stateChanges)) {
      throw new ObservationError('Invalid observation: stateChanges not an array');
    }

    if (typeof o.summary !== 'string') {
      throw new ObservationError('Invalid observation: missing summary');
    }

    if (typeof o.confidence !== 'number' || o.confidence < 0 || o.confidence > 1) {
      throw new ObservationError('Invalid observation: confidence must be 0-1');
    }

    if (typeof o.needsIteration !== 'boolean') {
      throw new ObservationError('Invalid observation: missing needsIteration');
    }

    // If needs iteration, must have reason
    if (o.needsIteration && typeof o.iterationReason !== 'string') {
      // Not required, but recommended - don't throw
    }
  }

  /**
   * Apply iteration limit to observation
   */
  private applyIterationLimit(observation: Observation, context: AgentContext): Observation {
    const currentIteration = context.currentIteration ?? 0;

    if (currentIteration >= this.config.maxIterations) {
      return {
        ...observation,
        needsIteration: false,
        iterationReason: observation.needsIteration
          ? `Max iterations (${this.config.maxIterations}) reached. Original reason: ${observation.iterationReason ?? 'unspecified'}`
          : observation.iterationReason,
      };
    }

    return observation;
  }

  private serializeResultData(data: unknown): string {
    try {
      const serialized = JSON.stringify(data);

      if (serialized.length <= MAX_RESULT_CHARS) {
        return serialized;
      }

      const head = serialized.slice(0, Math.floor(MAX_RESULT_CHARS * 0.75));
      const tail = serialized.slice(-Math.floor(MAX_RESULT_CHARS * 0.15));
      return `${head}...[truncated ${serialized.length - MAX_RESULT_CHARS} chars]...${tail}`;
    } catch {
      return '[unserializable result]';
    }
  }

  private resolveTimeoutForAttempt(attempt: number): number {
    if (attempt === 0) {
      return this.config.timeout;
    }

    const expanded = Math.max(this.config.timeout + 15000, Math.round(this.config.timeout * 1.5));
    return Math.max(this.config.timeout, Math.min(expanded, 90000));
  }

  private shouldRetryObservation(
    error: unknown,
    aborted: boolean,
    attempt: number,
    maxAttempts: number,
  ): boolean {
    if (aborted || attempt >= maxAttempts - 1) {
      return false;
    }

    if (error instanceof ObservationTimeoutError) {
      return true;
    }

    const message = error instanceof Error ? error.message : String(error);
    return /timeout|timed out|rate limit|429|503|network|temporar|service unavailable|failed to parse structured response|invalid json|unterminated string/i.test(
      message,
    );
  }

  private delay(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new ObservationError('Observation aborted'));
        return;
      }

      let settled = false;
      let timeoutId: ReturnType<typeof setTimeout> | null = null;

      const cleanup = () => {
        signal?.removeEventListener('abort', abortHandler);
      };

      const abortHandler = () => {
        if (settled) {
          return;
        }
        settled = true;
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
        cleanup();
        reject(new ObservationError('Observation aborted'));
      };

      timeoutId = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        resolve();
      }, ms);

      signal?.addEventListener('abort', abortHandler);
    });
  }

  // ===========================================================================
  // Private Methods - Execution
  // ===========================================================================

  /**
   * Execute operation with timeout
   */
  private async executeWithTimeout<T>(operation: () => Promise<T>, timeout: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false;

      const signal = this.abortController?.signal;
      const cleanup = () => {
        if (signal) {
          signal.removeEventListener('abort', abortHandler);
        }
      };

      const failAsAborted = () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeoutId);
        cleanup();
        reject(new ObservationError('Observation aborted'));
      };

      const failAsTimeout = () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeoutId);
        cleanup();
        this.llm.abort();
        reject(new ObservationTimeoutError(timeout));
      };

      const timeoutId = setTimeout(() => {
        failAsTimeout();
      }, timeout);

      const abortHandler = () => {
        failAsAborted();
      };

      if (this.abortController?.signal.aborted) {
        failAsAborted();
        return;
      }

      if (signal) {
        signal.addEventListener('abort', abortHandler);
      }

      operation()
        .then((result) => {
          if (!settled) {
            settled = true;
            clearTimeout(timeoutId);
            cleanup();
            resolve(result);
          }
        })
        .catch((error) => {
          if (!settled) {
            settled = true;
            clearTimeout(timeoutId);
            cleanup();
            reject(error);
          }
        });
    });
  }
}

// =============================================================================
// Factory Functions
// =============================================================================

/**
 * Create a new Observer instance
 *
 * @param llm - LLM client for generating observations
 * @param config - Optional configuration
 * @returns Configured Observer instance
 */
export function createObserver(llm: ILLMClient, config?: ObserverConfig): Observer {
  return new Observer(llm, config);
}
