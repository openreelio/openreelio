/**
 * AgentLoop - Simplified Agentic Loop (opencode-style)
 *
 * Replaces the 4-phase TPAO engine with a simpler pattern:
 *   stream LLM response -> execute tool calls -> loop if more tools needed
 *
 * The LLM itself decides the plan implicitly through tool selection.
 * Fast-path parsing is reused for simple deterministic requests.
 *
 * Feature flag: USE_AGENT_LOOP (default: false)
 */

import type {
  ILLMClient,
  LLMMessage,
  LLMToolDefinition,
  GenerateOptions,
} from './ports/ILLMClient';
import type {
  IToolExecutor,
  ExecutionContext,
  ToolExecutionResult,
} from './ports/IToolExecutor';
import type {
  AgentContext,
  RiskLevel,
} from './core/types';
import type { ConversationMessage, TokenUsage } from './core/conversation';
import { toSimpleLLMMessages } from './core/conversation';
import { parseFastPathPlan, type FastPathMatch } from './core/fastPathParser';
import { DoomLoopDetector } from './core/DoomLoopDetector';
import { Compaction } from './core/compaction';
import { resolveMaxOutputTokens, resolveContextLimit } from './core/modelRegistry';
import { createLogger } from '@/services/logger';

const logger = createLogger('AgentLoop');

// =============================================================================
// Event Types (simplified compared to TPAO)
// =============================================================================

/**
 * Events emitted during agent loop execution.
 *
 * These are a simplified subset compared to the full AgentEvent union from the
 * TPAO engine, focused on streaming-first usage.
 */
export type AgentLoopEvent =
  | TextDeltaEvent
  | ReasoningDeltaEvent
  | ToolCallStartEvent
  | ToolCallCompleteEvent
  | ToolPermissionRequestEvent
  | ToolsExecutedEvent
  | CompactedEvent
  | DoomLoopDetectedEvent
  | ErrorEvent
  | DoneEvent;

export interface TextDeltaEvent {
  type: 'text_delta';
  content: string;
}

export interface ReasoningDeltaEvent {
  type: 'reasoning_delta';
  content: string;
}

export interface ToolCallStartEvent {
  type: 'tool_call_start';
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ToolCallCompleteEvent {
  type: 'tool_call_complete';
  id: string;
  name: string;
  result: ToolCallResult;
}

export interface ToolPermissionRequestEvent {
  type: 'tool_permission_request';
  id: string;
  tool: string;
  riskLevel: RiskLevel;
}

export interface ToolsExecutedEvent {
  type: 'tools_executed';
  results: ToolCallResult[];
}

export interface CompactedEvent {
  type: 'compacted';
  summary: string;
}

export interface DoomLoopDetectedEvent {
  type: 'doom_loop_detected';
  tool: string;
  count: number;
}

export interface ErrorEvent {
  type: 'error';
  error: Error;
}

export interface DoneEvent {
  type: 'done';
  usage?: TokenUsage;
  fastPath?: boolean;
}

// =============================================================================
// Tool Call Result (simpler than full ToolResult)
// =============================================================================

export interface ToolCallResult {
  toolCallId: string;
  tool: string;
  success: boolean;
  data?: unknown;
  error?: string;
  duration: number;
}

// =============================================================================
// Configuration
// =============================================================================

export interface AgentLoopConfig {
  /** Maximum iterations (LLM roundtrips) before stopping. Default: 20 */
  maxIterations: number;
  /** Enable fast-path parsing for simple commands. Default: true */
  enableFastPath: boolean;
  /** Minimum fast-path confidence. Default: 0.85 */
  fastPathConfidenceThreshold: number;
  /** Context token limit for compaction checks. Default: 128_000 */
  contextLimit: number;
  /** Doom loop detection threshold (consecutive identical calls). Default: 3 */
  doomLoopThreshold: number;
  /** Minimum risk level requiring permission. Default: 'high' */
  approvalThreshold: RiskLevel;
  /** Active model identifier for token budget resolution */
  activeModel?: string;
  /** Active provider identifier for token budget resolution */
  activeProvider?: string;
  /** LLM generation options */
  generateOptions?: GenerateOptions;
  /**
   * Per-tool permission handler.
   * Called before each tool execution. Returns:
   * - 'allow': proceed
   * - 'deny': skip this tool call
   * - 'allow_always': proceed and auto-allow for session
   */
  toolPermissionHandler?: (
    toolName: string,
    args: Record<string, unknown>,
    riskLevel: RiskLevel,
  ) => Promise<'allow' | 'deny' | 'allow_always'>;
  /** Callback to refresh context between iterations */
  contextRefresher?: () => Partial<AgentContext> | Promise<Partial<AgentContext>>;
}

export const DEFAULT_AGENT_LOOP_CONFIG: AgentLoopConfig = {
  maxIterations: 20,
  enableFastPath: true,
  fastPathConfidenceThreshold: 0.85,
  contextLimit: 128_000,
  doomLoopThreshold: 3,
  approvalThreshold: 'high',
};

// =============================================================================
// AgentLoop Class
// =============================================================================

export class AgentLoop {
  private readonly llm: ILLMClient;
  private readonly tools: IToolExecutor;
  private readonly config: AgentLoopConfig;
  private abortController: AbortController | null = null;

  constructor(
    llm: ILLMClient,
    tools: IToolExecutor,
    config: Partial<AgentLoopConfig> = {},
  ) {
    this.llm = llm;
    this.tools = tools;

    // Resolve context limit and maxTokens from model metadata if not explicitly set
    const merged = { ...DEFAULT_AGENT_LOOP_CONFIG, ...config };

    if (!config.contextLimit) {
      merged.contextLimit = resolveContextLimit(merged.activeModel, merged.activeProvider);
    }

    if (!merged.generateOptions?.maxTokens) {
      const resolved = resolveMaxOutputTokens(
        merged.generateOptions?.maxTokens,
        merged.activeModel,
        merged.activeProvider,
      );
      if (resolved) {
        merged.generateOptions = { ...merged.generateOptions, maxTokens: resolved };
      }
    }

    this.config = merged;
  }

  /**
   * Run the agent loop.
   *
   * This is the main entry point. It yields AgentLoopEvents as the loop
   * progresses, allowing the caller to stream results to the UI.
   *
   * @param sessionId - Conversation session ID
   * @param input - User's text input
   * @param context - Agent execution context (project, timeline, assets)
   * @param conversationHistory - Previous messages for multi-turn context
   * @param signal - Optional external AbortSignal
   */
  async *run(
    sessionId: string,
    input: string,
    context: AgentContext,
    conversationHistory: ConversationMessage[] = [],
    signal?: AbortSignal,
  ): AsyncGenerator<AgentLoopEvent, void, unknown> {
    this.abortController = new AbortController();

    // Link external signal to our internal controller
    const onExternalAbort = () => this.abortController?.abort();
    signal?.addEventListener('abort', onExternalAbort);

    try {
      yield* this.runLoop(sessionId, input, context, conversationHistory);
    } finally {
      signal?.removeEventListener('abort', onExternalAbort);
      this.abortController = null;
    }
  }

  /**
   * Abort the current run.
   */
  abort(): void {
    this.abortController?.abort();
  }

  /**
   * Whether a run is currently in progress.
   */
  isRunning(): boolean {
    return this.abortController !== null;
  }

  // ===========================================================================
  // Private: Main Loop
  // ===========================================================================

  private async *runLoop(
    sessionId: string,
    input: string,
    context: AgentContext,
    conversationHistory: ConversationMessage[],
  ): AsyncGenerator<AgentLoopEvent, void, unknown> {
    // 1. Fast-path check
    if (this.config.enableFastPath) {
      const fastResult = this.tryFastPath(input, context);
      if (fastResult) {
        logger.info('Fast path match', {
          strategy: fastResult.strategy,
          confidence: fastResult.confidence,
        });
        yield* this.executeFastPath(fastResult, context, sessionId);
        return;
      }
    }

    // 2. Build message history
    const toolDefs = this.buildToolDefinitions();
    let messages = this.buildMessages(input, context, conversationHistory);

    const doomDetector = new DoomLoopDetector(this.config.doomLoopThreshold);
    let totalUsage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    let step = 0;

    // 3. The loop
    while (step < this.config.maxIterations) {
      this.checkAborted();
      step++;

      logger.debug('Agent loop iteration', { step, messageCount: messages.length });

      // Stream LLM response
      const toolCalls: Array<{
        id: string;
        name: string;
        args: Record<string, unknown>;
      }> = [];
      let assistantText = '';

      for await (const event of this.llm.generateWithTools(
        messages,
        toolDefs,
        this.config.generateOptions,
      )) {
        this.checkAborted();

        switch (event.type) {
          case 'text':
            assistantText += event.content;
            yield { type: 'text_delta', content: event.content };
            break;

          case 'reasoning':
            yield { type: 'reasoning_delta', content: event.content ?? '' };
            break;

          case 'tool_call':
            toolCalls.push({
              id: event.id,
              name: event.name,
              args: event.args,
            });
            yield {
              type: 'tool_call_start',
              id: event.id,
              name: event.name,
              args: event.args,
            };
            break;

          case 'done':
            if (event.usage) {
              totalUsage = {
                promptTokens: totalUsage.promptTokens + (event.usage.inputTokens ?? 0),
                completionTokens: totalUsage.completionTokens + (event.usage.outputTokens ?? 0),
                totalTokens:
                  totalUsage.totalTokens +
                  (event.usage.inputTokens ?? 0) +
                  (event.usage.outputTokens ?? 0),
              };
            }
            break;

          case 'error':
            yield { type: 'error', error: event.error };
            yield { type: 'done', usage: totalUsage };
            return;
        }
      }

      // No tool calls? We're done.
      if (toolCalls.length === 0) {
        yield { type: 'done', usage: totalUsage };
        return;
      }

      // Execute tools
      const results = await this.executeToolCalls(
        toolCalls,
        context,
        sessionId,
        doomDetector,
      );

      // Yield tool completion events
      for (const result of results.results) {
        yield {
          type: 'tool_call_complete',
          id: result.toolCallId,
          name: result.tool,
          result,
        };
      }

      yield { type: 'tools_executed', results: results.results };

      // Check doom loop
      if (results.doomLoopDetected) {
        yield {
          type: 'doom_loop_detected',
          tool: results.doomLoopTool ?? 'unknown',
          count: this.config.doomLoopThreshold,
        };
        yield { type: 'done', usage: totalUsage };
        return;
      }

      // Append assistant message + tool results to history
      messages = this.appendToolRoundtrip(
        messages,
        assistantText,
        toolCalls,
        results.results,
      );

      // Check context overflow -> compact
      if (Compaction.shouldCompact(totalUsage, this.config.contextLimit)) {
        const convMessages = this.llmMessagesToConversation(messages);
        const compacted = await Compaction.compact(
          convMessages,
          this.llm,
          this.config.contextLimit,
        );
        messages = compacted.messages.map((m) => ({
          role: m.role as 'system' | 'user' | 'assistant' | 'tool',
          content: m.parts
            .map((p) => (p.type === 'text' ? p.content : ''))
            .join('\n'),
        }));
        // Re-append user message after compaction
        messages.push({ role: 'user', content: input });
        yield { type: 'compacted', summary: compacted.summary };
      }

      // Refresh context if handler provided
      if (this.config.contextRefresher && step > 1) {
        try {
          const fresh = await this.config.contextRefresher();
          context = {
            ...context,
            ...fresh,
            projectId: context.projectId,       // immutable identity
            sequenceId: context.sequenceId,      // immutable identity
            availableTools: context.availableTools, // preserve tools
          };
        } catch {
          logger.warn('Context refresh failed, continuing with previous context');
        }
      }
    }

    // Max iterations reached
    yield {
      type: 'error',
      error: new Error(
        `Agent loop reached maximum iterations (${this.config.maxIterations})`,
      ),
    };
    yield { type: 'done', usage: totalUsage };
  }

  // ===========================================================================
  // Private: Fast Path
  // ===========================================================================

  private tryFastPath(input: string, context: AgentContext): FastPathMatch | null {
    return parseFastPathPlan(input, context, this.tools, {
      minConfidence: this.config.fastPathConfidenceThreshold,
    });
  }

  private async *executeFastPath(
    match: FastPathMatch,
    context: AgentContext,
    sessionId: string,
  ): AsyncGenerator<AgentLoopEvent, void, unknown> {
    const step = match.plan.steps[0];
    if (!step) {
      yield { type: 'done', fastPath: true };
      return;
    }

    // Check permission for fast-path execution
    const riskLevel = step.riskLevel;
    const permitted = await this.checkPermission(step.tool, step.args, riskLevel);
    if (permitted === 'deny') {
      yield {
        type: 'text_delta',
        content: `Action "${step.tool}" was denied by permission policy.`,
      };
      yield { type: 'done', fastPath: true };
      return;
    }

    yield {
      type: 'tool_call_start',
      id: `fastpath-${step.id}`,
      name: step.tool,
      args: step.args,
    };

    const execCtx: ExecutionContext = {
      projectId: context.projectId,
      sequenceId: context.sequenceId,
      sessionId,
    };

    const startTime = Date.now();
    let result: ToolExecutionResult;
    try {
      result = await this.tools.execute(step.tool, step.args, execCtx);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      yield {
        type: 'tool_call_complete',
        id: `fastpath-${step.id}`,
        name: step.tool,
        result: {
          toolCallId: `fastpath-${step.id}`,
          tool: step.tool,
          success: false,
          error: error.message,
          duration: Date.now() - startTime,
        },
      };
      yield { type: 'error', error };
      yield { type: 'done', fastPath: true };
      return;
    }

    const callResult: ToolCallResult = {
      toolCallId: `fastpath-${step.id}`,
      tool: step.tool,
      success: result.success,
      data: result.data,
      error: result.error,
      duration: result.duration,
    };

    yield {
      type: 'tool_call_complete',
      id: callResult.toolCallId,
      name: step.tool,
      result: callResult,
    };

    if (result.success) {
      yield {
        type: 'text_delta',
        content: `Done. ${step.description}`,
      };
    } else {
      yield {
        type: 'text_delta',
        content: `Failed: ${result.error ?? 'Unknown error'}`,
      };
    }

    yield { type: 'done', fastPath: true };
  }

  // ===========================================================================
  // Private: Tool Execution
  // ===========================================================================

  private async executeToolCalls(
    toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }>,
    context: AgentContext,
    sessionId: string,
    doomDetector: DoomLoopDetector,
  ): Promise<{
    results: ToolCallResult[];
    doomLoopDetected: boolean;
    doomLoopTool?: string;
  }> {
    const results: ToolCallResult[] = [];
    let doomLoopDetected = false;
    let doomLoopTool: string | undefined;

    const execCtx: ExecutionContext = {
      projectId: context.projectId,
      sequenceId: context.sequenceId,
      sessionId,
    };

    for (const call of toolCalls) {
      this.checkAborted();

      // Doom loop check
      if (doomDetector.check(call.name, call.args)) {
        doomLoopDetected = true;
        doomLoopTool = call.name;
        logger.warn('Doom loop detected', { tool: call.name });
        break;
      }

      // Permission check
      const toolDef = this.tools.getToolDefinition(call.name);
      const riskLevel = toolDef?.riskLevel ?? 'low';
      const permitted = await this.checkPermission(call.name, call.args, riskLevel);

      if (permitted === 'deny') {
        results.push({
          toolCallId: call.id,
          tool: call.name,
          success: false,
          error: 'Tool execution denied by permission policy',
          duration: 0,
        });
        continue;
      }

      // Execute tool
      const startTime = Date.now();
      try {
        const execResult = await this.tools.execute(call.name, call.args, execCtx);
        results.push({
          toolCallId: call.id,
          tool: call.name,
          success: execResult.success,
          data: execResult.data,
          error: execResult.error,
          duration: execResult.duration,
        });
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        results.push({
          toolCallId: call.id,
          tool: call.name,
          success: false,
          error: error.message,
          duration: Date.now() - startTime,
        });
      }
    }

    return { results, doomLoopDetected, doomLoopTool };
  }

  // ===========================================================================
  // Private: Permission
  // ===========================================================================

  private async checkPermission(
    tool: string,
    args: Record<string, unknown>,
    riskLevel: RiskLevel,
  ): Promise<'allow' | 'deny' | 'allow_always'> {
    if (!this.config.toolPermissionHandler) {
      return 'allow';
    }

    const threshold = this.config.approvalThreshold;
    const riskLevels: RiskLevel[] = ['low', 'medium', 'high', 'critical'];
    if (riskLevels.indexOf(riskLevel) < riskLevels.indexOf(threshold)) {
      return 'allow'; // Below threshold, auto-allow
    }

    return this.config.toolPermissionHandler(tool, args, riskLevel);
  }

  // ===========================================================================
  // Private: Message Building
  // ===========================================================================

  private buildToolDefinitions(): LLMToolDefinition[] {
    return this.tools.getAvailableTools().map((tool) => {
      const def = this.tools.getToolDefinition(tool.name);
      return {
        name: tool.name,
        description: tool.description,
        parameters: def?.parameters ?? {},
      };
    });
  }

  private buildMessages(
    input: string,
    context: AgentContext,
    conversationHistory: ConversationMessage[],
  ): LLMMessage[] {
    const messages: LLMMessage[] = [];

    // System message with context
    const systemContent = this.buildSystemMessage(context);
    messages.push({ role: 'system', content: systemContent });

    // Previous conversation history
    if (conversationHistory.length > 0) {
      const historyMessages = toSimpleLLMMessages(conversationHistory);
      messages.push(...historyMessages);
    }

    // Current user input
    messages.push({ role: 'user', content: input });

    return messages;
  }

  private buildSystemMessage(context: AgentContext): string {
    const parts: string[] = [
      'You are an AI video editing assistant for OpenReelio.',
      'You help users edit videos through natural language commands.',
      'Use the provided tools to execute editing operations.',
      'Be concise and action-oriented. Execute commands directly when possible.',
      '',
      '<environment>',
      `Project: ${context.projectId}`,
      `Timeline Duration: ${context.timelineDuration}s`,
      `Playhead: ${context.playheadPosition}s`,
      `Selected Clips: ${context.selectedClips.length}`,
      `Selected Tracks: ${context.selectedTracks.length}`,
      `Available Assets: ${context.availableAssets.length}`,
      `Available Tracks: ${context.availableTracks.length}`,
      '</environment>',
    ];

    if (context.availableAssets.length > 0) {
      parts.push('', '<assets>');
      for (const asset of context.availableAssets.slice(0, 20)) {
        parts.push(`- ${asset.name} (${asset.type}${asset.duration ? `, ${asset.duration}s` : ''})`);
      }
      parts.push('</assets>');
    }

    if (context.availableTracks.length > 0) {
      parts.push('', '<tracks>');
      for (const track of context.availableTracks) {
        parts.push(`- ${track.name} (${track.type}, ${track.clipCount} clips)`);
      }
      parts.push('</tracks>');
    }

    return parts.join('\n');
  }

  private appendToolRoundtrip(
    messages: LLMMessage[],
    assistantText: string,
    toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }>,
    results: ToolCallResult[],
  ): LLMMessage[] {
    const updated = [...messages];

    // Append assistant message with tool calls
    const toolCallsText = toolCalls
      .map((tc) => `[Tool Call: ${tc.name}(${JSON.stringify(tc.args)})]`)
      .join('\n');
    const fullAssistantContent = assistantText
      ? `${assistantText}\n\n${toolCallsText}`
      : toolCallsText;

    updated.push({ role: 'assistant', content: fullAssistantContent });

    // Append one tool message per result, each with its own toolCallId
    for (const result of results) {
      const content = result.success
        ? `[${result.tool}] Success: ${result.data !== undefined ? JSON.stringify(result.data) : 'ok'}`
        : `[${result.tool}] Error: ${result.error ?? 'Unknown error'}`;

      updated.push({
        role: 'tool',
        content,
        toolCallId: result.toolCallId,
      });
    }

    return updated;
  }

  // ===========================================================================
  // Private: Helpers
  // ===========================================================================

  private checkAborted(): void {
    if (this.abortController?.signal.aborted) {
      throw new AgentLoopAbortedError();
    }
  }

  /**
   * Convert LLM messages back into ConversationMessage[] for Compaction.
   * This is a lossy conversion; we convert to simple text messages.
   */
  private llmMessagesToConversation(
    messages: LLMMessage[],
  ): ConversationMessage[] {
    return messages.map((msg) => ({
      id: crypto.randomUUID(),
      role: msg.role === 'tool' ? 'assistant' : (msg.role as 'system' | 'user' | 'assistant'),
      parts: [{ type: 'text' as const, content: msg.content }],
      timestamp: Date.now(),
    }));
  }
}

// =============================================================================
// Errors
// =============================================================================

export class AgentLoopAbortedError extends Error {
  constructor() {
    super('Agent loop was aborted');
    this.name = 'AgentLoopAbortedError';
  }
}

// =============================================================================
// Factory
// =============================================================================

export function createAgentLoop(
  llm: ILLMClient,
  tools: IToolExecutor,
  config?: Partial<AgentLoopConfig>,
): AgentLoop {
  return new AgentLoop(llm, tools, config);
}
