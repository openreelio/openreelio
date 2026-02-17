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
}

/**
 * Default configuration values
 */
const DEFAULT_CONFIG: Required<PlannerConfig> = {
  timeout: 60000, // 60 seconds (structured output is slow)
  maxSteps: 20,
  approvalRequiredRisks: ['high', 'critical'],
  systemPromptOverride: '',
};

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
    this.abortController = new AbortController();

    const messages = this.buildMessages(thought, context, history);
    const schema = this.buildPlanSchema();

    try {
      const plan = await this.executeWithTimeout(
        () => this.llm.generateStructured<Plan>(messages, schema),
        this.config.timeout,
      );

      // Validate the plan
      this.validatePlan(plan);

      return plan;
    } catch (error) {
      if (error instanceof PlanningTimeoutError) {
        throw error;
      }
      if (error instanceof PlanValidationError) {
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

    const messages = this.buildMessages(thought, context, history);

    try {
      // Stream the planning process for UI feedback
      for await (const chunk of this.llm.generateStream(messages)) {
        if (this.abortController?.signal.aborted) {
          break;
        }
        onProgress(chunk);
      }

      // Check abort before making additional LLM call
      if (this.abortController?.signal.aborted) {
        throw new PlanValidationError('Planning aborted', []);
      }

      // Get the structured result
      const schema = this.buildPlanSchema();
      const plan = await this.llm.generateStructured<Plan>(messages, schema);

      this.validatePlan(plan);
      return plan;
    } catch (error) {
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
  ): LLMMessage[] {
    const systemPrompt = this.buildSystemPrompt(context);
    const userPrompt = this.buildUserPrompt(thought);
    const messages: LLMMessage[] = [{ role: 'system', content: systemPrompt }];

    // Insert conversation history between system prompt and current input
    if (history && history.length > 0) {
      messages.push(...history);
    }

    messages.push({ role: 'user', content: userPrompt });
    return messages;
  }

  /**
   * Build system prompt with available tools and context
   */
  private buildSystemPrompt(context: AgentContext): string {
    if (this.config.systemPromptOverride) {
      return this.config.systemPromptOverride;
    }

    const parts: string[] = [
      'You are a planning assistant for a video editing application.',
      'Your task is to create an execution plan based on the analyzed intent.',
      '',
      'Current Context:',
      `- Project ID: ${context.projectId || '(unknown)'}`,
      context.sequenceId ? `- Sequence ID: ${context.sequenceId}` : '- Sequence ID: (none)',
      `- Playhead position: ${context.playheadPosition} seconds`,
      `- Timeline duration: ${context.timelineDuration} seconds`,
      context.selectedClips.length > 0
        ? `- Selected clips: ${context.selectedClips.join(', ')}`
        : '- Selected clips: (none)',
      context.selectedTracks.length > 0
        ? `- Selected tracks: ${context.selectedTracks.join(', ')}`
        : '- Selected tracks: (none)',
      `- Available assets: ${context.availableAssets.length}`,
      `- Available tracks: ${context.availableTracks.length}`,
      '',
      'Available Tools:',
    ];

    // Add available tools with descriptions
    const tools = this.toolExecutor.getAvailableTools();
    for (const tool of tools) {
      const definition = this.toolExecutor.getToolDefinition(tool.name);
      parts.push(`- ${tool.name}: ${tool.description}`);
      parts.push(`  Risk Level: ${tool.riskLevel}`);
      parts.push(`  Parallelizable: ${tool.parallelizable ? 'yes' : 'no'}`);
      if (definition?.required && definition.required.length > 0) {
        parts.push(`  Required args: ${definition.required.join(', ')}`);
      }
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
  private validatePlan(plan: unknown): asserts plan is Plan {
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
      const stepErrors = this.validateStep(steps[i], i, stepIds);
      errors.push(...stepErrors);
    }

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
  private validateStep(step: unknown, index: number, existingIds: Set<string>): string[] {
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
        const validation = this.toolExecutor.validateArgs(s.tool, args);
        if (!validation.valid) {
          errors.push(
            `Step ${index}: invalid arguments for '${s.tool}': ${validation.errors.join(', ')}`,
          );
        }
      }
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

      const timeoutId = setTimeout(() => {
        if (!settled) {
          settled = true;
          this.abort();
          reject(new PlanningTimeoutError(timeout));
        }
      }, timeout);

      const abortHandler = () => {
        if (!settled) {
          settled = true;
          clearTimeout(timeoutId);
          reject(new PlanningTimeoutError(timeout));
        }
      };

      if (this.abortController?.signal.aborted) {
        clearTimeout(timeoutId);
        reject(new PlanningTimeoutError(timeout));
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
