/**
 * Planner Phase - Execution Plan Generation
 *
 * The second phase of the agentic loop that generates an
 * ordered execution plan from a thought.
 *
 * Responsibilities:
 * - Generate ordered steps from thought analysis
 * - Identify tool dependencies
 * - Detect parallelization opportunities
 * - Validate tool availability and arguments
 * - Flag high-risk operations for approval
 * - Create rollback strategies
 */

import type { ILLMClient, LLMMessage } from '../ports/ILLMClient';
import type { IToolExecutor } from '../ports/IToolExecutor';
import type {
  AgentContext,
  LanguagePolicy,
  Thought,
  Plan,
  PlanStep,
  RiskLevel,
} from '../core/types';
import { PlanningTimeoutError, PlanValidationError } from '../core/errors';
import { createLogger } from '@/services/logger';
import {
  collectStepValueReferences,
  normalizeReferencesForValidation,
} from '../core/stepReferences';
import { buildOrchestrationPlaybook } from '../core/orchestrationPlaybooks';

const logger = createLogger('Planner');

// =============================================================================
// Types
// =============================================================================

/**
 * Configuration for the Planner phase
 */
export interface PlannerConfig {
  /** Timeout for planning operation in milliseconds */
  timeout?: number;
  /** Maximum number of steps allowed in a plan */
  maxSteps?: number;
  /** Risk levels that require approval */
  approvalRequiredRisks?: RiskLevel[];
  /** Custom system prompt override */
  systemPromptOverride?: string;
  /** Number of retries after initial planning attempt */
  maxRetries?: number;
  /** Backoff in milliseconds between retries */
  retryBackoffMs?: number;
  /** Maximum tools included in compact retry prompt */
  compactPromptToolLimit?: number;
  /** Max output tokens for LLM generation (resolved from model metadata + user settings) */
  maxOutputTokens?: number;
}

/**
 * Default configuration values
 */
const DEFAULT_CONFIG: Required<PlannerConfig> = {
  timeout: 60000, // 60 seconds (structured output is slow)
  maxSteps: 20,
  approvalRequiredRisks: ['high', 'critical'],
  systemPromptOverride: '',
  maxRetries: 1,
  retryBackoffMs: 400,
  compactPromptToolLimit: 24,
  maxOutputTokens: undefined as unknown as number,
};

const ID_PLACEHOLDER_PATTERNS: RegExp[] = [
  /(?:^|[_-])(placeholder|example|sample|dummy|temp|todo|tbd|unknown)(?:$|[_-])/i,
  /_from_(catalog|list|lookup|response|result)/i,
  /^asset_id(?:_|$)/i,
];

const TRACK_ALIAS_PATTERNS: RegExp[] = [/^(video|audio)_[0-9]+$/i];
const CONTEXT_LIST_LIMIT = 40;
const COMPACT_CONTEXT_LIST_LIMIT = 12;
const TOOL_PROMPT_LIMIT = 80;
const HISTORY_MESSAGE_LIMIT = 16;
const COMPACT_HISTORY_MESSAGE_LIMIT = 8;
const HISTORY_MESSAGE_CHAR_LIMIT = 1800;
const COMPACT_HISTORY_MESSAGE_CHAR_LIMIT = 900;

type PromptDetailLevel = 'full' | 'compact';

const ORCHESTRATION_PLAYBOOK_LINES: string[] = [
  'Orchestration Playbooks (use when request matches):',
  '- Playbook: B-roll + music + subtitles',
  '  1) Discover usable source assets/tracks, 2) place B-roll clips, 3) add/adjust music bed, 4) add timed captions.',
  '- Playbook: Generate then place on timeline',
  '  1) generate_video, 2) check_generation_status, 3) insert_clip or insert_clip_from_file when output is ready.',
  '- Playbook: Workspace file onboarding',
  '  1) find/get workspace files, 2) register or insert via insert_clip_from_file, 3) apply timing/audio/caption polish.',
];

// =============================================================================
// Planner Class
// =============================================================================

/**
 * Planner phase implementation
 *
 * Generates an ordered execution plan from a thought analysis.
 * Validates tools, dependencies, and creates rollback strategies.
 *
 * @example
 * ```typescript
 * const planner = createPlanner(llmClient, toolExecutor);
 * const plan = await planner.plan(thought, context);
 *
 * if (plan.requiresApproval) {
 *   // Ask user for confirmation
 * } else {
 *   // Proceed to execution
 * }
 * ```
 */
export class Planner {
  private readonly llm: ILLMClient;
  private readonly toolExecutor: IToolExecutor;
  private readonly config: Required<PlannerConfig>;
  private abortController: AbortController | null = null;

  constructor(llm: ILLMClient, toolExecutor: IToolExecutor, config: PlannerConfig = {}) {
    this.llm = llm;
    this.toolExecutor = toolExecutor;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ===========================================================================
  // Public Methods
  // ===========================================================================

  /**
   * Generate an execution plan from a thought
   *
   * @param thought - Analyzed thought from Thinker phase
   * @param context - Current agent context
   * @param history - Optional conversation history for multi-turn context
   * @returns Validated execution plan
   * @throws PlanningTimeoutError if operation times out
   * @throws PlanValidationError if plan is invalid
   */
  async plan(thought: Thought, context: AgentContext, history?: LLMMessage[]): Promise<Plan> {
    const playbookMatch = buildOrchestrationPlaybook(thought, context, this.toolExecutor);
    if (playbookMatch) {
      this.validatePlan(playbookMatch.plan, context);
      return playbookMatch.plan;
    }

    const schema = this.buildPlanSchema();
    const maxAttempts = this.config.maxRetries + 1;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const promptMode: PromptDetailLevel = attempt === 0 ? 'full' : 'compact';
      const timeoutMs = this.resolveTimeoutForAttempt(attempt);
      const messages = this.buildMessages(thought, context, history, promptMode);

      this.abortController = new AbortController();

      try {
        logger.debug('Planning attempt started', {
          attempt: attempt + 1,
          maxAttempts,
          promptMode,
          timeoutMs,
          messageCount: messages.length,
          promptChars: messages.reduce((sum, message) => sum + message.content.length, 0),
        });

        // Use a generous output budget so structured Plan JSON is never
        // truncated — especially important for complex multi-step plans
        // and non-ASCII prompts (Korean, Japanese, etc.) that consume
        // 2-3× more tokens per character.  Compact retry keeps the same
        // output budget since it already saves tokens on the input side.
        const plan = await this.executeWithTimeout(
          () =>
            this.llm.generateStructured<Plan>(messages, schema, {
              maxTokens: this.config.maxOutputTokens ?? 16384,
              temperature: 0.2,
            }),
          timeoutMs,
        );

        this.validatePlan(plan, context);
        return plan;
      } catch (error) {
        const aborted = this.abortController?.signal.aborted ?? false;

        if (error instanceof PlanValidationError) {
          throw error;
        }

        const shouldRetry = this.shouldRetryPlanning(error, aborted, attempt, maxAttempts);
        if (shouldRetry) {
          const backoffMs = this.config.retryBackoffMs * (attempt + 1);
          logger.warn('Planning attempt failed; retrying with compact prompt', {
            attempt: attempt + 1,
            maxAttempts,
            backoffMs,
            error: error instanceof Error ? error.message : String(error),
          });
          await this.delay(backoffMs);
          continue;
        }

        if (error instanceof PlanningTimeoutError) {
          throw error;
        }

        throw new PlanValidationError(
          `Failed to generate plan: ${error instanceof Error ? error.message : String(error)}`,
          [],
        );
      } finally {
        this.abortController = null;
      }
    }

    throw new PlanValidationError('Failed to generate plan after retries', []);
  }

  /**
   * Generate plan with streaming progress updates
   *
   * @param thought - Analyzed thought
   * @param context - Current agent context
   * @param onProgress - Callback for progress updates
   * @returns Validated execution plan
   */
  async planWithStreaming(
    thought: Thought,
    context: AgentContext,
    onProgress: (chunk: string) => void,
    history?: LLMMessage[],
  ): Promise<Plan> {
    this.abortController = new AbortController();

    const playbookMatch = buildOrchestrationPlaybook(thought, context, this.toolExecutor);
    if (playbookMatch) {
      onProgress(`Using deterministic orchestration playbook: ${playbookMatch.id}`);
      this.validatePlan(playbookMatch.plan, context);
      return playbookMatch.plan;
    }

    const schema = this.buildPlanSchema();
    // Append structured output instructions to messages so the streamed
    // response already contains the JSON we need — avoiding a second LLM call.
    const schemaInstruction = [
      'Return ONLY a JSON object that strictly matches this JSON Schema.',
      'Do not include markdown code fences, comments, or additional text.',
      '',
      'JSON Schema:',
      JSON.stringify(schema),
    ].join('\n');
    const messages = this.buildMessages(thought, context, history);
    messages.push({ role: 'system', content: schemaInstruction });

    try {
      // Stream the planning process for UI feedback while accumulating text
      let accumulated = '';
      for await (const chunk of this.llm.generateStream(messages)) {
        if (this.abortController?.signal.aborted) {
          break;
        }
        accumulated += chunk;
        onProgress(chunk);
      }

      if (this.abortController?.signal.aborted) {
        throw new PlanValidationError('Planning aborted', []);
      }

      // Parse the accumulated streaming output as structured JSON
      // instead of making a second LLM call
      const plan = this.parseAccumulatedPlan<Plan>(accumulated);

      this.validatePlan(plan, context);
      return plan;
    } catch (error) {
      if (error instanceof PlanValidationError) {
        throw error;
      }
      throw new PlanValidationError(
        `Failed to generate plan with streaming: ${error instanceof Error ? error.message : String(error)}`,
        [],
      );
    } finally {
      this.abortController = null;
    }
  }

  /**
   * Abort ongoing planning operation
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
   * Build messages for LLM including system prompt, optional history, and thought context
   */
  private buildMessages(
    thought: Thought,
    context: AgentContext,
    history?: LLMMessage[],
    promptDetailLevel: PromptDetailLevel = 'full',
  ): LLMMessage[] {
    const systemPrompt = this.buildSystemPrompt(context, promptDetailLevel);
    const userPrompt = this.buildUserPrompt(thought);
    const messages: LLMMessage[] = [{ role: 'system', content: systemPrompt }];

    // Insert conversation history between system prompt and current input
    const preparedHistory = this.prepareHistory(history, promptDetailLevel);
    if (preparedHistory.length > 0) {
      messages.push(...preparedHistory);
    }

    messages.push({ role: 'user', content: userPrompt });
    return messages;
  }

  /**
   * Build system prompt with available tools and context
   */
  private buildSystemPrompt(
    context: AgentContext,
    promptDetailLevel: PromptDetailLevel = 'full',
  ): string {
    if (this.config.systemPromptOverride) {
      return this.config.systemPromptOverride;
    }

    const contextListLimit =
      promptDetailLevel === 'compact' ? COMPACT_CONTEXT_LIST_LIMIT : CONTEXT_LIST_LIMIT;

    const parts: string[] = [
      'You are a planning assistant for a video editing application.',
      'Your task is to create an execution plan based on the analyzed intent.',
      '',
      'Current Context:',
      `- Project ID: ${context.projectId || '(unknown)'}`,
      context.sequenceId ? `- Sequence ID: ${context.sequenceId}` : '- Sequence ID: (none)',
      `- Project state version: ${context.projectStateVersion ?? '(unknown)'}`,
      `- Playhead position: ${context.playheadPosition} seconds`,
      `- Timeline duration: ${context.timelineDuration} seconds`,
      context.selectedClips.length > 0
        ? `- Selected clips: ${context.selectedClips.join(', ')}`
        : '- Selected clips: (none)',
      context.selectedTracks.length > 0
        ? `- Selected tracks: ${context.selectedTracks.join(', ')}`
        : '- Selected tracks: (none)',
      '',
      'Available Tools:',
    ];

    if (context.availableAssets.length === 0) {
      parts.push('- Available assets: (none)');
    } else {
      parts.push(`- Available assets (${context.availableAssets.length}):`);
      for (const asset of context.availableAssets.slice(0, contextListLimit)) {
        parts.push(`  - ${asset.id} (${asset.type}) ${asset.name}`);
      }
      if (context.availableAssets.length > contextListLimit) {
        const omittedCount = context.availableAssets.length - contextListLimit;
        parts.push(`  - ... ${omittedCount} more asset IDs omitted for brevity`);
      }
    }

    if (context.availableTracks.length === 0) {
      parts.push('- Available tracks: (none)');
    } else {
      parts.push(`- Available tracks (${context.availableTracks.length}):`);
      for (const track of context.availableTracks.slice(0, contextListLimit)) {
        parts.push(`  - ${track.id} (${track.type}, clips=${track.clipCount}) ${track.name}`);
      }
      if (context.availableTracks.length > contextListLimit) {
        const omittedCount = context.availableTracks.length - contextListLimit;
        parts.push(`  - ... ${omittedCount} more track IDs omitted for brevity`);
      }
    }

    // Add available tools with descriptions
    const tools = this.toolExecutor.getAvailableTools();
    const toolListLimit =
      promptDetailLevel === 'compact' ? this.config.compactPromptToolLimit : TOOL_PROMPT_LIMIT;
    const visibleTools = tools.slice(0, toolListLimit);

    for (const tool of visibleTools) {
      const definition = this.toolExecutor.getToolDefinition(tool.name);
      parts.push(`- ${tool.name}: ${tool.description}`);
      if (promptDetailLevel === 'full') {
        parts.push(`  Risk Level: ${tool.riskLevel}`);
        parts.push(`  Parallelizable: ${tool.parallelizable ? 'yes' : 'no'}`);
      }
      if (definition?.required && definition.required.length > 0) {
        const requiredPreview = definition.required.slice(0, 12);
        parts.push(`  Required args: ${requiredPreview.join(', ')}`);
      }
    }

    if (tools.length > visibleTools.length) {
      parts.push(
        `- ... ${tools.length - visibleTools.length} more tools omitted in ${promptDetailLevel} prompt mode`,
      );
    }

    if (promptDetailLevel === 'compact') {
      parts.push(
        '- Prompt mode: compact retry. Keep steps concise and prioritize essential actions.',
      );
    }

    this.appendLanguagePolicyInstructions(parts, context.languagePolicy);

    parts.push('');
    parts.push('Planning Guidelines:');
    parts.push('1. Break down complex tasks into ordered steps');
    parts.push('2. Specify dependencies between steps using dependsOn');
    parts.push('3. Mark steps as parallelizable when they have no dependencies');
    parts.push('4. Set requiresApproval=true for high-risk or destructive operations');
    parts.push('5. Provide a rollback strategy in case of failure');
    parts.push(`6. Maximum ${this.config.maxSteps} steps allowed`);
    parts.push(
      '7. When the request references source footage discovery or selecting moments, include source-aware analysis steps before edit actions (for example: catalog/unused-asset checks).',
    );
    parts.push(
      '8. Never invent or normalize IDs. Always copy exact IDs from analysis output (no placeholders like asset_id_from_catalog or aliases like video_1).',
    );
    parts.push(
      '9. When a step needs data from an earlier step, bind the argument using a step reference object: {"$fromStep":"<step-id>","$path":"data.<fieldPath>"}.',
    );
    parts.push(
      '10. Every step that uses a step reference must include dependsOn entries for all referenced step IDs.',
    );
    parts.push('');
    parts.push(...ORCHESTRATION_PLAYBOOK_LINES);

    return parts.join('\n');
  }

  private appendLanguagePolicyInstructions(parts: string[], languagePolicy?: LanguagePolicy): void {
    if (!languagePolicy) {
      return;
    }

    parts.push('');
    parts.push('Language Policy:');
    parts.push(`- UI language: ${languagePolicy.uiLanguage}`);
    parts.push(`- Default output language: ${languagePolicy.outputLanguage}`);
    parts.push(
      `- Detect input language: ${languagePolicy.detectInputLanguage ? 'enabled' : 'disabled'}`,
    );
    parts.push(
      `- User language override: ${languagePolicy.allowUserLanguageOverride ? 'allowed' : 'disallowed'}`,
    );
    parts.push(
      '- Keep natural-language fields (goal, step descriptions, rollback strategy) in the default output language unless user explicitly asks otherwise.',
    );
    parts.push('- Never translate tool names, IDs, argument keys, or JSON schema keys.');
  }

  /**
   * Build user prompt from thought
   */
  private buildUserPrompt(thought: Thought): string {
    const parts: string[] = [
      'Create an execution plan for the following intent:',
      '',
      `Understanding: ${thought.understanding}`,
      '',
      'Requirements:',
      ...thought.requirements.map((r) => `- ${r}`),
      '',
      `Proposed Approach: ${thought.approach}`,
    ];

    if (thought.uncertainties.length > 0) {
      parts.push('');
      parts.push('Note: Some uncertainties exist:');
      parts.push(...thought.uncertainties.map((u) => `- ${u}`));
    }

    return parts.join('\n');
  }

  private prepareHistory(
    history: LLMMessage[] | undefined,
    promptDetailLevel: PromptDetailLevel,
  ): LLMMessage[] {
    if (!history || history.length === 0) {
      return [];
    }

    const messageLimit =
      promptDetailLevel === 'compact' ? COMPACT_HISTORY_MESSAGE_LIMIT : HISTORY_MESSAGE_LIMIT;
    const charLimit =
      promptDetailLevel === 'compact'
        ? COMPACT_HISTORY_MESSAGE_CHAR_LIMIT
        : HISTORY_MESSAGE_CHAR_LIMIT;

    return history.slice(-messageLimit).map((message) => ({
      ...message,
      content: this.truncateMessageContent(message.content, charLimit),
    }));
  }

  private truncateMessageContent(content: string, maxChars: number): string {
    if (content.length <= maxChars) {
      return content;
    }

    const head = content.slice(0, Math.floor(maxChars * 0.75));
    const tail = content.slice(-Math.floor(maxChars * 0.15));
    return `${head}\n...[truncated ${content.length - maxChars} chars]...\n${tail}`;
  }

  private resolveTimeoutForAttempt(attempt: number): number {
    if (attempt === 0) {
      return this.config.timeout;
    }

    const expanded = Math.max(this.config.timeout + 30000, Math.round(this.config.timeout * 1.5));
    return Math.min(expanded, 180000);
  }

  private shouldRetryPlanning(
    error: unknown,
    aborted: boolean,
    attempt: number,
    maxAttempts: number,
  ): boolean {
    if (aborted || attempt >= maxAttempts - 1) {
      return false;
    }

    if (error instanceof PlanningTimeoutError) {
      return true;
    }

    const message = error instanceof Error ? error.message : String(error);
    return /timeout|timed out|rate limit|429|503|network|temporar|service unavailable|failed to parse structured response|invalid json|unterminated string/i.test(
      message,
    );
  }

  /**
   * Parse accumulated streaming text into a structured plan.
   * Handles raw JSON, code-fenced JSON, and embedded JSON objects.
   */
  private parseAccumulatedPlan<T>(text: string): T {
    const trimmed = text.replace(/^\uFEFF/, '').trim();
    if (trimmed.length === 0) {
      throw new PlanValidationError('Empty response from LLM during streaming', []);
    }

    // Try raw parse first
    try {
      return JSON.parse(trimmed) as T;
    } catch {
      // continue to fallback strategies
    }

    // Try extracting from code fences
    const fenceRegex = /```(?:json)?\s*([\s\S]*?)```/gi;
    for (const match of trimmed.matchAll(fenceRegex)) {
      const candidate = match[1]?.trim();
      if (candidate) {
        try {
          return JSON.parse(candidate) as T;
        } catch {
          // continue
        }
      }
    }

    // Try extracting balanced JSON object
    const objStart = trimmed.indexOf('{');
    if (objStart >= 0) {
      const balanced = this.extractBalancedBraces(trimmed, objStart);
      if (balanced) {
        try {
          return JSON.parse(balanced) as T;
        } catch {
          // fall through
        }
      }
    }

    const preview = trimmed.slice(0, 160).replace(/\s+/g, ' ');
    throw new PlanValidationError(
      `Failed to parse streaming plan output as JSON: ${preview}...`,
      [],
    );
  }

  /**
   * Extract a balanced JSON substring starting at the given index.
   */
  private extractBalancedBraces(text: string, start: number): string | null {
    const stack: string[] = ['}'];
    let inString = false;
    let escaped = false;

    for (let i = start + 1; i < text.length; i++) {
      const char = text[i];
      if (inString) {
        if (escaped) { escaped = false; continue; }
        if (char === '\\') { escaped = true; continue; }
        if (char === '"') { inString = false; }
        continue;
      }
      if (char === '"') { inString = true; continue; }
      if (char === '{') { stack.push('}'); continue; }
      if (char === '[') { stack.push(']'); continue; }
      if (char === '}' || char === ']') {
        if (stack.pop() !== char) return null;
        if (stack.length === 0) return text.slice(start, i + 1);
      }
    }
    return null;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Build JSON schema for structured plan output
   */
  private buildPlanSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        goal: {
          type: 'string',
          description: 'The overall goal of the plan',
        },
        steps: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Unique step identifier' },
              tool: { type: 'string', description: 'Name of the tool to execute' },
              args: { type: 'object', description: 'Arguments for the tool' },
              description: { type: 'string', description: 'Human-readable description' },
              riskLevel: {
                type: 'string',
                enum: ['low', 'medium', 'high', 'critical'],
              },
              estimatedDuration: { type: 'number', description: 'Estimated duration in ms' },
              dependsOn: {
                type: 'array',
                items: { type: 'string' },
                description: 'IDs of steps this step depends on',
              },
            },
            required: ['id', 'tool', 'args', 'description', 'riskLevel', 'estimatedDuration'],
          },
        },
        estimatedTotalDuration: {
          type: 'number',
          description: 'Total estimated duration in ms',
        },
        requiresApproval: {
          type: 'boolean',
          description: 'Whether user approval is needed before execution',
        },
        rollbackStrategy: {
          type: 'string',
          description: 'Strategy for rolling back if execution fails',
        },
      },
      required: ['goal', 'steps', 'estimatedTotalDuration', 'requiresApproval', 'rollbackStrategy'],
    };
  }

  // ===========================================================================
  // Private Methods - Validation
  // ===========================================================================

  /**
   * Validate the generated plan
   */
  private validatePlan(plan: unknown, context: AgentContext): asserts plan is Plan {
    const errors: string[] = [];

    // Basic structure validation
    if (!plan || typeof plan !== 'object') {
      throw new PlanValidationError('Invalid plan: not an object', []);
    }

    const p = plan as Record<string, unknown>;

    if (typeof p.goal !== 'string') {
      errors.push('Missing or invalid goal');
    }

    if (!Array.isArray(p.steps)) {
      errors.push('Missing or invalid steps array');
    }

    if (typeof p.requiresApproval !== 'boolean') {
      errors.push('Missing or invalid requiresApproval');
    }

    if (typeof p.rollbackStrategy !== 'string') {
      errors.push('Missing or invalid rollbackStrategy');
    }

    if (errors.length > 0) {
      throw new PlanValidationError('Plan structure validation failed', errors);
    }

    const steps = p.steps as unknown[];

    // Validate step count
    if (steps.length > this.config.maxSteps) {
      throw new PlanValidationError(`Plan exceeds maximum step limit of ${this.config.maxSteps}`, [
        `Got ${steps.length} steps, maximum is ${this.config.maxSteps}`,
      ]);
    }

    // Validate each step
    const stepIds = new Set<string>();
    for (let i = 0; i < steps.length; i++) {
      const stepErrors = this.validateStep(steps[i], i, stepIds, context);
      errors.push(...stepErrors);
    }

    const stepReferenceErrors = this.validateStepReferences(steps as PlanStep[]);
    errors.push(...stepReferenceErrors);

    if (errors.length > 0) {
      throw new PlanValidationError('Step validation failed', errors);
    }

    // Validate dependencies
    const dependencyErrors = this.validateDependencies(steps as PlanStep[]);
    if (dependencyErrors.length > 0) {
      throw new PlanValidationError('Dependency validation failed', dependencyErrors);
    }
  }

  /**
   * Validate a single step
   */
  private validateStep(
    step: unknown,
    index: number,
    existingIds: Set<string>,
    context: AgentContext,
  ): string[] {
    const errors: string[] = [];

    if (!step || typeof step !== 'object') {
      errors.push(`Step ${index}: not an object`);
      return errors;
    }

    const s = step as Record<string, unknown>;

    // Required fields
    if (typeof s.id !== 'string' || s.id === '') {
      errors.push(`Step ${index}: missing or invalid id`);
    } else {
      if (existingIds.has(s.id)) {
        errors.push(`Step ${index}: duplicate id '${s.id}'`);
      }
      existingIds.add(s.id);
    }

    if (typeof s.tool !== 'string' || s.tool === '') {
      errors.push(`Step ${index}: missing or invalid tool`);
    } else {
      // Validate tool exists
      if (!this.toolExecutor.hasTool(s.tool)) {
        errors.push(`Step ${index}: unknown tool '${s.tool}'`);
      } else {
        // Validate tool arguments
        const args = (s.args ?? {}) as Record<string, unknown>;
        const argsForValidation = this.normalizeArgsForValidation(s.tool, args);
        const validation = this.toolExecutor.validateArgs(s.tool, argsForValidation);
        if (!validation.valid) {
          errors.push(
            `Step ${index}: invalid arguments for '${s.tool}': ${validation.errors.join(', ')}`,
          );
        }
      }
    }

    if (typeof s.tool === 'string') {
      const contextBindingErrors = this.validateContextBoundArguments(
        index,
        s.tool,
        s.args,
        context,
      );
      errors.push(...contextBindingErrors);
    }

    if (typeof s.description !== 'string') {
      errors.push(`Step ${index}: missing description`);
    }

    if (!['low', 'medium', 'high', 'critical'].includes(s.riskLevel as string)) {
      errors.push(`Step ${index}: invalid riskLevel`);
    }

    if (typeof s.estimatedDuration !== 'number') {
      errors.push(`Step ${index}: missing estimatedDuration`);
    }

    return errors;
  }

  private validateContextBoundArguments(
    index: number,
    toolName: string,
    rawArgs: unknown,
    context: AgentContext,
  ): string[] {
    if (!rawArgs || typeof rawArgs !== 'object') {
      return [];
    }

    const args = rawArgs as Record<string, unknown>;
    const errors: string[] = [];

    for (const [key, value] of Object.entries(args)) {
      if (!key.endsWith('Id') || typeof value !== 'string') {
        continue;
      }

      if (this.isPlaceholderId(value, key)) {
        errors.push(
          `Step ${index}: '${toolName}' uses placeholder-like ${key}='${value}'. Use exact IDs from analysis results.`,
        );
      }
    }

    const knownTrackIds = new Set(context.availableTracks.map((track) => track.id));
    for (const key of ['trackId', 'newTrackId', 'sourceTrackId', 'targetTrackId']) {
      const value = args[key];
      if (typeof value === 'string' && knownTrackIds.size > 0 && !knownTrackIds.has(value)) {
        errors.push(
          `Step ${index}: '${toolName}' references unknown ${key}='${value}' for current context.`,
        );
      }
    }

    const knownAssetIds = new Set(context.availableAssets.map((asset) => asset.id));
    for (const key of ['assetId', 'sourceAssetId', 'targetAssetId']) {
      const value = args[key];
      if (typeof value === 'string' && knownAssetIds.size > 0 && !knownAssetIds.has(value)) {
        errors.push(
          `Step ${index}: '${toolName}' references unknown ${key}='${value}' for current context.`,
        );
      }
    }

    if (
      typeof args.sequenceId === 'string' &&
      typeof context.sequenceId === 'string' &&
      context.sequenceId.length > 0 &&
      args.sequenceId !== context.sequenceId
    ) {
      errors.push(
        `Step ${index}: '${toolName}' sequenceId='${args.sequenceId}' does not match active sequence '${context.sequenceId}'.`,
      );
    }

    return errors;
  }

  private normalizeArgsForValidation(
    toolName: string,
    args: Record<string, unknown>,
  ): Record<string, unknown> {
    const toolDefinition = this.toolExecutor.getToolDefinition(toolName);
    const normalized = normalizeReferencesForValidation(args, toolDefinition?.parameters);

    if (!normalized || typeof normalized !== 'object' || Array.isArray(normalized)) {
      return args;
    }

    return normalized as Record<string, unknown>;
  }

  private validateStepReferences(steps: PlanStep[]): string[] {
    const errors: string[] = [];
    const knownStepIds = new Set(steps.map((step) => step.id));

    steps.forEach((step, index) => {
      const references = collectStepValueReferences(step.args);
      if (references.length === 0) {
        return;
      }

      const dependencies = new Set(step.dependsOn ?? []);

      for (const occurrence of references) {
        const { reference } = occurrence;

        if (!knownStepIds.has(reference.$fromStep)) {
          errors.push(
            `Step ${index}: reference at '${occurrence.sourcePath}' points to unknown step '${reference.$fromStep}'.`,
          );
          continue;
        }

        if (reference.$fromStep === step.id) {
          errors.push(
            `Step ${index}: reference at '${occurrence.sourcePath}' cannot target the same step '${step.id}'.`,
          );
        }

        if (!dependencies.has(reference.$fromStep)) {
          errors.push(
            `Step ${index}: reference at '${occurrence.sourcePath}' requires dependsOn to include '${reference.$fromStep}'.`,
          );
        }

        const usesDataContract = /^data(?:\.|\[|$)/.test(reference.$path);
        if (!usesDataContract) {
          errors.push(
            `Step ${index}: reference at '${occurrence.sourcePath}' must read from 'data.*' to use tool output contracts.`,
          );
        }
      }
    });

    return errors;
  }

  private isPlaceholderId(value: string, key: string): boolean {
    if (ID_PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(value))) {
      return true;
    }

    if (
      key.toLowerCase().includes('track') &&
      TRACK_ALIAS_PATTERNS.some((pattern) => pattern.test(value))
    ) {
      return true;
    }

    return false;
  }

  /**
   * Validate step dependencies
   */
  private validateDependencies(steps: PlanStep[]): string[] {
    const errors: string[] = [];
    const stepIds = new Set(steps.map((s) => s.id));

    for (const step of steps) {
      if (step.dependsOn) {
        for (const depId of step.dependsOn) {
          if (!stepIds.has(depId)) {
            errors.push(`Step '${step.id}' depends on unknown step '${depId}'`);
          }
        }
      }
    }

    // Check for circular dependencies
    const circularError = this.detectCircularDependencies(steps);
    if (circularError) {
      errors.push(circularError);
    }

    return errors;
  }

  /**
   * Detect circular dependencies in the step graph
   */
  private detectCircularDependencies(steps: PlanStep[]): string | null {
    const visited = new Set<string>();
    const recursionStack = new Set<string>();
    const stepMap = new Map(steps.map((s) => [s.id, s]));

    const hasCycle = (stepId: string): boolean => {
      if (recursionStack.has(stepId)) {
        return true;
      }
      if (visited.has(stepId)) {
        return false;
      }

      visited.add(stepId);
      recursionStack.add(stepId);

      const step = stepMap.get(stepId);
      if (step?.dependsOn) {
        for (const depId of step.dependsOn) {
          if (hasCycle(depId)) {
            return true;
          }
        }
      }

      recursionStack.delete(stepId);
      return false;
    };

    for (const step of steps) {
      if (hasCycle(step.id)) {
        return `Circular dependency detected involving step '${step.id}'`;
      }
    }

    return null;
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
        reject(new PlanValidationError('Planning aborted', []));
      };

      const failAsTimeout = () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeoutId);
        cleanup();
        this.llm.abort();
        reject(new PlanningTimeoutError(timeout));
      };

      const abortHandler = () => {
        failAsAborted();
      };

      const timeoutId = setTimeout(() => {
        failAsTimeout();
      }, timeout);

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
 * Create a new Planner instance
 *
 * @param llm - LLM client for generating plans
 * @param toolExecutor - Tool executor for validating tools
 * @param config - Optional configuration
 * @returns Configured Planner instance
 */
export function createPlanner(
  llm: ILLMClient,
  toolExecutor: IToolExecutor,
  config?: PlannerConfig,
): Planner {
  return new Planner(llm, toolExecutor, config);
}
