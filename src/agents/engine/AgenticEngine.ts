/**
 * AgenticEngine - Main Orchestrator
 *
 * Orchestrates the Think → Plan → Act → Observe loop for AI-driven
 * video editing operations.
 *
 * Design notes:
 * - Uses hexagonal ports (ILLMClient / IToolExecutor) for infrastructure.
 * - Emits strongly typed AgentEvent events for UI streaming.
 * - Returns a final AgentState snapshot for debugging and persistence.
 */

import type { ILLMClient, LLMMessage } from './ports/ILLMClient';
import type { IToolExecutor, ExecutionContext, ToolExecutionResult } from './ports/IToolExecutor';
import type {
  AgentContext,
  AgentEvent,
  AgentPhase,
  AgentState,
  AgenticEngineConfig,
  ExecutionRecord,
  Observation,
  Plan,
  PlanStep,
  RiskLevel,
  SessionSummary,
  Thought,
  ToolResult,
} from './core/types';
import { createInitialState, mergeConfig } from './core/types';
import { MaxIterationsError, SessionActiveError } from './core/errors';
import { Thinker, createThinker } from './phases/Thinker';
import { Planner, createPlanner } from './phases/Planner';
import { Executor, createExecutor, type ExecutionResult } from './phases/Executor';
import { Observer, createObserver } from './phases/Observer';
import { createLogger } from '@/services/logger';

const logger = createLogger('AgenticEngine');

// =============================================================================
// Types
// =============================================================================

/**
 * Result of running the agentic engine.
 *
 * `finalState` is always present and is safe to persist as a snapshot.
 */
export interface AgentRunResult {
  /** Whether the overall operation succeeded */
  success: boolean;
  /** Final observation from the observe phase */
  observation?: Observation;
  /** Execution results from each iteration */
  executionResults: ExecutionResult[];
  /** Total number of iterations */
  iterations: number;
  /** Total duration in milliseconds */
  totalDuration: number;
  /** Whether the process was aborted */
  aborted: boolean;
  /** Whether clarification is needed from user */
  needsClarification?: boolean;
  /** Question to ask user for clarification */
  clarificationQuestion?: string;
  /** Whether approval is needed for the plan */
  needsApproval?: boolean;
  /** The plan waiting for approval */
  pendingPlan?: Plan;
  /** Whether approval was denied */
  approvalDenied?: boolean;
  /** Error if the process failed */
  error?: Error;
  /** Final state snapshot for UI/debugging */
  finalState: AgentState;
  /** Session summary (also emitted via session_complete) */
  summary?: SessionSummary;
}

// =============================================================================
// AgenticEngine Class
// =============================================================================

export class AgenticEngine {
  private readonly toolExecutor: IToolExecutor;
  private readonly config: AgenticEngineConfig;
  private readonly approvalHandler: (plan: Plan) => Promise<boolean>;

  private readonly thinker: Thinker;
  private readonly planner: Planner;
  private readonly executor: Executor;
  private readonly observer: Observer;

  private isAborted = false;
  private currentPhase: AgentPhase = 'idle';
  private activeSessionId: string | null = null;

  constructor(
    llm: ILLMClient,
    toolExecutor: IToolExecutor,
    config: Partial<AgenticEngineConfig> = {}
  ) {
    this.toolExecutor = toolExecutor;
    this.config = mergeConfig(config);
    this.approvalHandler = this.config.approvalHandler ?? (async () => false);

    const approvalRequiredRisks = risksAtOrAbove(this.config.approvalThreshold);

    this.thinker = createThinker(llm, { timeout: this.config.thinkingTimeout });
    this.planner = createPlanner(llm, toolExecutor, {
      timeout: this.config.planningTimeout,
      approvalRequiredRisks,
    });
    this.executor = createExecutor(toolExecutor, {
      stopOnError: this.config.stopOnError ?? true,
      stepTimeout: this.config.executionTimeout,
      maxRetries: this.config.autoRetryOnFailure ? this.config.maxRetries : 0,
    });
    this.observer = createObserver(llm, {
      timeout: this.config.observationTimeout,
      maxIterations: this.config.maxIterations,
    });
  }

  // ===========================================================================
  // Public Methods
  // ===========================================================================

  async run(
    input: string,
    agentContext: AgentContext,
    executionContext: ExecutionContext,
    onEvent?: (event: AgentEvent) => void,
    conversationHistory?: LLMMessage[]
  ): Promise<AgentRunResult> {
    if (this.activeSessionId) {
      const err = new SessionActiveError(this.activeSessionId);
      this.emitEvent(onEvent, { type: 'session_failed', error: err, timestamp: Date.now() });

      const finalState = createInitialState(
        executionContext.sessionId,
        input,
        agentContext,
        this.config
      );

      return this.createResult(false, [], 0, 0, {
        error: err,
        finalState,
      });
    }

    this.activeSessionId = executionContext.sessionId;
    this.isAborted = false;

    const startTime = Date.now();
    const executionResults: ExecutionResult[] = [];

    let contextWithTools: AgentContext = {
      ...agentContext,
      availableTools:
        agentContext.availableTools.length > 0
          ? agentContext.availableTools
          : this.toolExecutor.getAvailableTools().map((t) => t.name),
    };

    let state = createInitialState(
      executionContext.sessionId,
      input,
      contextWithTools,
      this.config
    );

    this.emitEvent(onEvent, {
      type: 'session_start',
      sessionId: executionContext.sessionId,
      input,
      timestamp: Date.now(),
    });

    logger.info('Agent session started', {
      sessionId: executionContext.sessionId,
      projectId: contextWithTools.projectId,
      sequenceId: executionContext.sequenceId,
    });

    let iteration = 0;
    let lastObservation: Observation | undefined;

    try {
      while (iteration < this.config.maxIterations) {
        if (this.isAborted) {
          state = this.finalizeState(state, 'aborted');
          this.emitEvent(onEvent, {
            type: 'session_aborted',
            reason: 'Aborted by user',
            timestamp: Date.now(),
          });

          return this.createResult(false, executionResults, iteration, Date.now() - startTime, {
            aborted: true,
            finalState: state,
          });
        }

        iteration += 1;
        state.iteration = iteration;

        // Refresh context from stores if a refresher is provided (prevents stale state in multi-step tasks)
        if (this.config.contextRefresher && iteration > 1) {
          try {
            const freshContext = await this.config.contextRefresher();
            // Merge fresh partial context, preserving availableTools from initial setup
            contextWithTools = {
              ...contextWithTools,
              ...freshContext,
              availableTools: contextWithTools.availableTools,
            };
          } catch (error) {
            logger.warn('Context refresh failed, continuing with previous context', {
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }

        state.context = { ...contextWithTools, currentIteration: iteration };

        // =====================================================================
        // THINK
        // =====================================================================
        this.currentPhase = 'thinking';
        state.phase = 'thinking';
        this.emitEvent(onEvent, { type: 'thinking_start', timestamp: Date.now() });

        let thought: Thought;
        try {
          thought = await this.thinker.think(input, state.context, conversationHistory);
        } catch (error) {
          const err = asError(error);
          state.error = err;
          state = this.finalizeState(state, 'failed');
          this.emitEvent(onEvent, { type: 'session_failed', error: err, timestamp: Date.now() });
          logger.error('Thinking phase failed', { sessionId: executionContext.sessionId, error: err.message });

          return this.createResult(false, executionResults, iteration, Date.now() - startTime, {
            error: err,
            finalState: state,
          });
        }

        state.thought = thought;
        this.emitEvent(onEvent, { type: 'thinking_complete', thought, timestamp: Date.now() });

        if (thought.needsMoreInfo) {
          state = this.finalizeState(state, 'completed');
          const summary = this.createSummary(state, Date.now() - startTime);
          this.emitEvent(onEvent, { type: 'session_complete', summary, timestamp: Date.now() });

          return this.createResult(false, executionResults, iteration, Date.now() - startTime, {
            needsClarification: true,
            clarificationQuestion: thought.clarificationQuestion,
            finalState: state,
            summary,
          });
        }

        // =====================================================================
        // PLAN
        // =====================================================================
        this.currentPhase = 'planning';
        state.phase = 'planning';
        this.emitEvent(onEvent, { type: 'planning_start', timestamp: Date.now() });

        let plan: Plan;
        try {
          plan = await this.planner.plan(thought, state.context, conversationHistory);
        } catch (error) {
          const err = asError(error);
          state.error = err;
          state = this.finalizeState(state, 'failed');
          this.emitEvent(onEvent, { type: 'session_failed', error: err, timestamp: Date.now() });
          logger.error('Planning phase failed', { sessionId: executionContext.sessionId, error: err.message });

          return this.createResult(false, executionResults, iteration, Date.now() - startTime, {
            error: err,
            finalState: state,
          });
        }

        state.plan = plan;
        this.emitEvent(onEvent, { type: 'planning_complete', plan, timestamp: Date.now() });

        // =====================================================================
        // APPROVAL
        // =====================================================================
        if (plan.requiresApproval) {
          this.currentPhase = 'awaiting_approval';
          state.phase = 'awaiting_approval';

          this.emitEvent(onEvent, { type: 'approval_required', plan, timestamp: Date.now() });

          let approved: boolean;
          try {
            approved = await this.approvalHandler(plan);
          } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            state.error = err;
            state = this.finalizeState(state, 'failed');
            this.emitEvent(onEvent, { type: 'session_failed', error: err, timestamp: Date.now() });
            logger.error('Approval phase failed', { sessionId: executionContext.sessionId, error: err.message });
            return this.createResult(false, executionResults, iteration, Date.now() - startTime, {
              error: err,
              finalState: state,
            });
          }

          this.emitEvent(onEvent, {
            type: 'approval_response',
            approved,
            timestamp: Date.now(),
          });

          if (!approved) {
            state = this.finalizeState(state, 'completed');
            const summary = this.createSummary(state, Date.now() - startTime);
            this.emitEvent(onEvent, { type: 'session_complete', summary, timestamp: Date.now() });

            return this.createResult(false, executionResults, iteration, Date.now() - startTime, {
              needsApproval: true,
              pendingPlan: plan,
              approvalDenied: true,
              finalState: state,
              summary,
            });
          }
        }

        if (this.isAborted) {
          state = this.finalizeState(state, 'aborted');
          this.emitEvent(onEvent, {
            type: 'session_aborted',
            reason: 'Aborted by user',
            timestamp: Date.now(),
          });

          return this.createResult(false, executionResults, iteration, Date.now() - startTime, {
            aborted: true,
            finalState: state,
          });
        }

        // =====================================================================
        // EXECUTE
        // =====================================================================
        this.currentPhase = 'executing';
        state.phase = 'executing';

        const stepById = new Map<string, PlanStep>(plan.steps.map((s) => [s.id, s]));

        let executionResult: ExecutionResult;
        try {
          executionResult = await this.executor.execute(plan, executionContext, (progress) => {
            const step = progress.stepId ? stepById.get(progress.stepId) : undefined;
            if (!step) return;

            if (progress.phase === 'step_started') {
              this.emitEvent(onEvent, { type: 'execution_start', step, timestamp: Date.now() });
            }

            if (progress.phase === 'step_completed' || progress.phase === 'step_failed') {
              if (progress.result) {
                this.emitEvent(onEvent, {
                  type: 'execution_complete',
                  step,
                  result: this.toToolResult(progress.result),
                  timestamp: Date.now(),
                });
              }
            }

            const ratio =
              progress.totalSteps > 0
                ? (progress.completedCount + progress.failedCount) / progress.totalSteps
                : 0;

            this.emitEvent(onEvent, { type: 'execution_progress', step, progress: ratio, timestamp: Date.now() });
          });
        } catch (error) {
          const err = asError(error);
          state.error = err;
          state = this.finalizeState(state, 'failed');
          this.emitEvent(onEvent, { type: 'session_failed', error: err, timestamp: Date.now() });
          logger.error('Execution phase failed', { sessionId: executionContext.sessionId, error: err.message });

          return this.createResult(false, executionResults, iteration, Date.now() - startTime, {
            error: err,
            finalState: state,
          });
        }

        executionResults.push(executionResult);
        state.executionHistory.push(...this.toExecutionRecords(executionResult));

        if (this.isAborted || executionResult.aborted) {
          state = this.finalizeState(state, 'aborted');
          this.emitEvent(onEvent, { type: 'session_aborted', reason: 'Aborted by user', timestamp: Date.now() });

          return this.createResult(false, executionResults, iteration, Date.now() - startTime, {
            aborted: true,
            finalState: state,
          });
        }

        // =====================================================================
        // OBSERVE
        // =====================================================================
        this.currentPhase = 'observing';
        state.phase = 'observing';

        let observation: Observation;
        try {
          observation = await this.observer.observe(plan, executionResult, state.context);
        } catch (error) {
          const err = asError(error);
          state.error = err;
          state = this.finalizeState(state, 'failed');
          this.emitEvent(onEvent, { type: 'session_failed', error: err, timestamp: Date.now() });
          logger.error('Observation phase failed', { sessionId: executionContext.sessionId, error: err.message });

          return this.createResult(false, executionResults, iteration, Date.now() - startTime, {
            error: err,
            finalState: state,
          });
        }

        lastObservation = observation;
        this.emitEvent(onEvent, { type: 'observation_complete', observation, timestamp: Date.now() });

        // =====================================================================
        // DONE / ITERATE
        // =====================================================================
        if (observation.goalAchieved || !observation.needsIteration) {
          state = this.finalizeState(state, 'completed');
          const summary = this.createSummary(state, Date.now() - startTime);
          this.emitEvent(onEvent, { type: 'session_complete', summary, timestamp: Date.now() });

          logger.info('Agent session completed', {
            sessionId: executionContext.sessionId,
            success: observation.goalAchieved,
          });

          return this.createResult(
            observation.goalAchieved,
            executionResults,
            iteration,
            Date.now() - startTime,
            { observation, finalState: state, summary }
          );
        }

        this.emitEvent(onEvent, { type: 'iteration_complete', iteration, timestamp: Date.now() });
      }

      const err = new MaxIterationsError(this.config.maxIterations, 'observing');
      state.error = err;
      state = this.finalizeState(state, 'failed');
      this.emitEvent(onEvent, { type: 'session_failed', error: err, timestamp: Date.now() });

      return this.createResult(false, executionResults, iteration, Date.now() - startTime, {
        observation: lastObservation,
        error: err,
        finalState: state,
      });
    } finally {
      this.currentPhase = 'idle';
      this.activeSessionId = null;
    }
  }

  abort(): void {
    this.isAborted = true;
    this.thinker.abort();
    this.planner.abort();
    this.executor.abort();
    this.observer.abort();
  }

  getCurrentPhase(): AgentPhase {
    return this.currentPhase;
  }

  isRunning(): boolean {
    return this.currentPhase !== 'idle';
  }

  // ===========================================================================
  // Private Helpers
  // ===========================================================================

  private emitEvent(onEvent: ((event: AgentEvent) => void) | undefined, event: AgentEvent): void {
    if (!onEvent) return;
    try {
      onEvent(event);
    } catch (error) {
      logger.error('Error in agent event handler', { error });
    }
  }

  private finalizeState(state: AgentState, phase: AgentPhase): AgentState {
    return {
      ...state,
      phase,
      completedAt: Date.now(),
    };
  }

  private createSummary(state: AgentState, durationMs: number): SessionSummary {
    const executedSteps = state.executionHistory.length;
    const successfulSteps = state.executionHistory.filter((r) => r.result.success).length;
    const failedSteps = state.executionHistory.filter((r) => !r.result.success).length;

    return {
      sessionId: state.sessionId,
      input: state.input,
      totalIterations: state.iteration,
      executedSteps,
      successfulSteps,
      failedSteps,
      duration: durationMs,
      finalState: state.phase,
    };
  }

  private toToolResult(result: ToolExecutionResult): ToolResult {
    return {
      success: result.success,
      data: result.data,
      error: result.error,
      duration: result.duration,
    };
  }

  private toExecutionRecords(executionResult: ExecutionResult): ExecutionRecord[] {
    const toRecord = (r: (typeof executionResult.completedSteps)[number]): ExecutionRecord => ({
      action: {
        stepId: r.stepId,
        tool: r.tool,
        args: r.args,
      },
      result: this.toToolResult(r.result),
      timestamp: r.endTime,
    });

    return [...executionResult.completedSteps, ...executionResult.failedSteps].map(toRecord);
  }

  private createResult(
    success: boolean,
    executionResults: ExecutionResult[],
    iterations: number,
    totalDuration: number,
    options: Partial<Omit<AgentRunResult, 'success' | 'executionResults' | 'iterations' | 'totalDuration'>> & {
      finalState: AgentState;
    }
  ): AgentRunResult {
    return {
      success,
      executionResults,
      iterations,
      totalDuration,
      aborted: options.aborted ?? false,
      observation: options.observation,
      needsClarification: options.needsClarification,
      clarificationQuestion: options.clarificationQuestion,
      needsApproval: options.needsApproval,
      pendingPlan: options.pendingPlan,
      approvalDenied: options.approvalDenied,
      error: options.error,
      finalState: options.finalState,
      summary: options.summary,
    };
  }
}

// =============================================================================
// Factory
// =============================================================================

export function createAgenticEngine(
  llm: ILLMClient,
  toolExecutor: IToolExecutor,
  config?: Partial<AgenticEngineConfig>
): AgenticEngine {
  return new AgenticEngine(llm, toolExecutor, config);
}

// =============================================================================
// Helpers
// =============================================================================

function risksAtOrAbove(threshold: RiskLevel): RiskLevel[] {
  const ordered: RiskLevel[] = ['low', 'medium', 'high', 'critical'];
  const index = ordered.indexOf(threshold);
  if (index < 0) return ['high', 'critical'];
  return ordered.slice(index);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
