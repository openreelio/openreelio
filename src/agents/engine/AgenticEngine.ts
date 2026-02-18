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
import type { IMemoryStore } from './ports/IMemoryStore';
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
  RollbackReport,
  RiskLevel,
  SessionSummary,
  Thought,
  ToolResult,
} from './core/types';
import { createInitialState, mergeConfig } from './core/types';
import {
  DoomLoopError,
  MaxIterationsError,
  SessionActiveError,
  StepBudgetExceededError,
  ToolBudgetExceededError,
} from './core/errors';
import { parseFastPathPlan } from './core/fastPathParser';
import { Thinker, createThinker } from './phases/Thinker';
import { Planner, createPlanner } from './phases/Planner';
import {
  Executor,
  createExecutor,
  getPartialExecutionResult,
  type ExecutionResult,
} from './phases/Executor';
import { Observer, createObserver } from './phases/Observer';
import {
  detectImmediateTerminalFailure,
  detectRepeatedTerminalFailure,
  type TerminalFailureGuidance,
} from './phases/executionFailureUtils';
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
  /** Rollback report when recovery was attempted */
  rollbackReport?: RollbackReport;
}

// =============================================================================
// AgenticEngine Class
// =============================================================================

export class AgenticEngine {
  private readonly toolExecutor: IToolExecutor;
  private readonly config: AgenticEngineConfig;
  private readonly approvalHandler: (
    plan: Plan,
  ) => Promise<boolean | { approved: boolean; feedback?: string }>;
  private readonly memoryStore?: IMemoryStore;

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
    config: Partial<AgenticEngineConfig> = {},
  ) {
    this.toolExecutor = toolExecutor;
    this.config = mergeConfig(config);
    this.approvalHandler = this.config.approvalHandler ?? (async () => false);
    this.memoryStore = this.config.enableMemory ? this.config.memoryStore : undefined;

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
    conversationHistory?: LLMMessage[],
  ): Promise<AgentRunResult> {
    if (this.activeSessionId) {
      const err = new SessionActiveError(this.activeSessionId);
      this.emitEvent(onEvent, { type: 'session_failed', error: err, timestamp: Date.now() });

      const finalState = createInitialState(
        executionContext.sessionId,
        input,
        agentContext,
        this.config,
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
    let plannedStepCount = 0;
    let toolCallsUsed = 0;

    let contextWithTools = await this.hydrateContextWithMemory(agentContext);
    contextWithTools = {
      ...contextWithTools,
      availableTools:
        contextWithTools.availableTools.length > 0
          ? contextWithTools.availableTools
          : this.toolExecutor.getAvailableTools().map((t) => t.name),
    };

    let state = createInitialState(
      executionContext.sessionId,
      input,
      contextWithTools,
      this.config,
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

        const fastPathMatch =
          iteration === 1 && this.config.enableFastPath
            ? parseFastPathPlan(input, state.context, this.toolExecutor, {
                minConfidence: this.config.fastPathConfidenceThreshold,
              })
            : null;

        // =====================================================================
        // THINK
        // =====================================================================
        this.currentPhase = 'thinking';
        state.phase = 'thinking';
        this.emitEvent(onEvent, { type: 'thinking_start', timestamp: Date.now() });

        let thought: Thought;
        if (fastPathMatch) {
          thought = fastPathMatch.thought;
          logger.info('Fast path selected', {
            sessionId: executionContext.sessionId,
            strategy: fastPathMatch.strategy,
            confidence: fastPathMatch.confidence,
          });
        } else {
          try {
            thought = await this.thinker.think(input, state.context, conversationHistory);
          } catch (error) {
            const err = asError(error);
            state.error = err;
            state = this.finalizeState(state, 'failed');
            this.emitEvent(onEvent, { type: 'session_failed', error: err, timestamp: Date.now() });
            logger.error('Thinking phase failed', {
              sessionId: executionContext.sessionId,
              error: err.message,
            });

            return this.createResult(false, executionResults, iteration, Date.now() - startTime, {
              error: err,
              finalState: state,
            });
          }
        }

        state.thought = thought;
        this.emitEvent(onEvent, { type: 'thinking_complete', thought, timestamp: Date.now() });

        if (thought.needsMoreInfo) {
          const question =
            thought.clarificationQuestion?.trim() ||
            'Could you clarify your request so I can proceed?';

          this.emitEvent(onEvent, {
            type: 'clarification_required',
            question,
            thought,
            timestamp: Date.now(),
          });

          state = this.finalizeState(state, 'completed');
          const summary = this.createSummary(state, Date.now() - startTime);
          this.emitEvent(onEvent, { type: 'session_complete', summary, timestamp: Date.now() });

          return this.createResult(false, executionResults, iteration, Date.now() - startTime, {
            needsClarification: true,
            clarificationQuestion: question,
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
        if (fastPathMatch) {
          plan = fastPathMatch.plan;
        } else {
          try {
            plan = await this.planner.plan(thought, state.context, conversationHistory);
          } catch (error) {
            const err = asError(error);
            state.error = err;
            state = this.finalizeState(state, 'failed');
            this.emitEvent(onEvent, { type: 'session_failed', error: err, timestamp: Date.now() });
            logger.error('Planning phase failed', {
              sessionId: executionContext.sessionId,
              error: err.message,
            });

            return this.createResult(false, executionResults, iteration, Date.now() - startTime, {
              error: err,
              finalState: state,
            });
          }
        }

        plan = this.enforceDestructiveApproval(plan);

        const attemptedStepCount = plannedStepCount + plan.steps.length;
        if (attemptedStepCount > this.config.maxStepsPerRun) {
          const err = new StepBudgetExceededError(this.config.maxStepsPerRun, attemptedStepCount);
          state.error = err;
          state = this.finalizeState(state, 'failed');
          this.emitEvent(onEvent, { type: 'session_failed', error: err, timestamp: Date.now() });
          logger.error('Step budget exceeded', {
            sessionId: executionContext.sessionId,
            maxStepsPerRun: this.config.maxStepsPerRun,
            attemptedStepCount,
          });

          return this.createResult(false, executionResults, iteration, Date.now() - startTime, {
            error: err,
            finalState: state,
          });
        }
        plannedStepCount = attemptedStepCount;

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
          let feedback: string | undefined;
          try {
            const rawResult = await this.approvalHandler(plan);
            // Backward compat: handler may return plain boolean
            if (typeof rawResult === 'boolean') {
              approved = rawResult;
            } else {
              approved = rawResult.approved;
              feedback = rawResult.feedback;
            }
          } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            state.error = err;
            state = this.finalizeState(state, 'failed');
            this.emitEvent(onEvent, { type: 'session_failed', error: err, timestamp: Date.now() });
            logger.error('Approval phase failed', {
              sessionId: executionContext.sessionId,
              error: err.message,
            });
            return this.createResult(false, executionResults, iteration, Date.now() - startTime, {
              error: err,
              finalState: state,
            });
          }

          this.emitEvent(onEvent, {
            type: 'approval_response',
            approved,
            reason: feedback,
            timestamp: Date.now(),
          });

          if (!approved) {
            // If feedback was provided, inject as correction for next iteration
            if (feedback && feedback.trim().length > 0) {
              contextWithTools = {
                ...contextWithTools,
                corrections: [
                  ...contextWithTools.corrections,
                  {
                    original: plan.goal,
                    corrected: feedback,
                    context: `Plan rejected by user at iteration ${iteration}`,
                  },
                ],
              };
              // Continue to next iteration with feedback instead of terminating
              this.emitEvent(onEvent, {
                type: 'iteration_complete',
                iteration,
                timestamp: Date.now(),
              });
              continue;
            }

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
        const executionContextForIteration: ExecutionContext = {
          ...executionContext,
          expectedStateVersion:
            state.context.projectStateVersion ?? executionContext.expectedStateVersion,
        };
        const remainingToolCalls = this.config.maxToolCallsPerRun - toolCallsUsed;

        if (remainingToolCalls <= 0) {
          const err = new ToolBudgetExceededError(this.config.maxToolCallsPerRun, toolCallsUsed);
          state.error = err;
          state = this.finalizeState(state, 'failed');
          this.emitEvent(onEvent, { type: 'session_failed', error: err, timestamp: Date.now() });
          logger.error('Tool budget exhausted before execution', {
            sessionId: executionContext.sessionId,
            maxToolCallsPerRun: this.config.maxToolCallsPerRun,
            toolCallsUsed,
          });

          return this.createResult(false, executionResults, iteration, Date.now() - startTime, {
            error: err,
            finalState: state,
          });
        }

        // Build onBeforeStep handler for per-tool permission checks.
        // Uses a microtask race to detect if the handler resolves immediately
        // (auto-allow/deny from stored rules). Events are only emitted when
        // the handler blocks for user interaction ('ask' case).
        const onBeforeStep = this.config.toolPermissionHandler
          ? async (step: PlanStep): Promise<'allow' | 'deny' | 'allow_always'> => {
              const handler = this.config.toolPermissionHandler!;
              const decisionPromise = handler(step.tool, step.args, step);

              // Check if handler resolved within a microtask (auto-resolved)
              let autoResolved = false;
              let autoDecision: 'allow' | 'deny' | 'allow_always' | undefined;

              void decisionPromise.then((d) => {
                if (!autoResolved) {
                  autoResolved = true;
                  autoDecision = d;
                }
              });

              // Yield one microtask to let synchronous resolutions complete
              await Promise.resolve();

              if (autoResolved && autoDecision !== undefined) {
                // Auto-resolved from stored rules — no UI events needed
                return autoDecision;
              }

              // Handler is blocking (waiting for user) — emit UI events
              autoResolved = true; // Prevent double-set
              this.emitEvent(onEvent, {
                type: 'tool_permission_request',
                step,
                timestamp: Date.now(),
              });

              const decision = await decisionPromise;

              this.emitEvent(onEvent, {
                type: 'tool_permission_response',
                step,
                decision,
                timestamp: Date.now(),
              });

              return decision;
            }
          : undefined;

        let executionResult: ExecutionResult;
        try {
          executionResult = await this.executor.execute(
            plan,
            executionContextForIteration,
            (progress) => {
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

              this.emitEvent(onEvent, {
                type: 'execution_progress',
                step,
                progress: ratio,
                timestamp: Date.now(),
              });
            },
            { maxToolCalls: remainingToolCalls, onBeforeStep },
          );
        } catch (error) {
          const err = asError(error);

          // Emit doom loop event if applicable
          if (error instanceof DoomLoopError) {
            this.emitEvent(onEvent, {
              type: 'doom_loop_detected',
              tool: error.tool,
              count: error.consecutiveCalls,
              timestamp: Date.now(),
            });
          }

          const partialExecutionResult = getPartialExecutionResult(error);

          if (partialExecutionResult) {
            executionResults.push(partialExecutionResult);
            toolCallsUsed += partialExecutionResult.toolCallsUsed;
            state.executionHistory.push(...this.toExecutionRecords(partialExecutionResult));
            await this.recordExecutionOperations(
              partialExecutionResult,
              contextWithTools.projectId,
            );
          }

          const rollbackReport = await this.attemptRollback(executionResults, executionContext);

          state.error = err;
          state = this.finalizeState(state, 'failed');
          this.emitEvent(onEvent, { type: 'session_failed', error: err, timestamp: Date.now() });
          logger.error('Execution phase failed', {
            sessionId: executionContext.sessionId,
            error: err.message,
            rollbackAttempted: rollbackReport.attempted,
            rollbackSucceeded: rollbackReport.succeededCount,
            rollbackFailed: rollbackReport.failedCount,
            rollbackSkipped: rollbackReport.skippedCount,
          });

          const summary = this.createSummary(state, Date.now() - startTime, {
            failureReason: err.message,
            rollbackReport,
          });

          return this.createResult(false, executionResults, iteration, Date.now() - startTime, {
            error: err,
            finalState: state,
            summary,
            rollbackReport,
          });
        }

        executionResults.push(executionResult);
        toolCallsUsed += executionResult.toolCallsUsed;
        state.executionHistory.push(...this.toExecutionRecords(executionResult));
        await this.recordExecutionOperations(executionResult, contextWithTools.projectId);

        if (this.isAborted || executionResult.aborted) {
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
          logger.error('Observation phase failed', {
            sessionId: executionContext.sessionId,
            error: err.message,
          });

          return this.createResult(false, executionResults, iteration, Date.now() - startTime, {
            error: err,
            finalState: state,
          });
        }

        const immediateTerminalFailure = detectImmediateTerminalFailure(
          executionResult,
          state.context,
        );
        const repeatedTerminalFailure =
          executionResults.length > 1
            ? detectRepeatedTerminalFailure(
                executionResults[executionResults.length - 2],
                executionResult,
              )
            : null;

        const terminalFailureGuard = immediateTerminalFailure ?? repeatedTerminalFailure;
        if (observation.needsIteration && terminalFailureGuard) {
          logger.warn('Stopping automatic retry loop after terminal failure', {
            sessionId: executionContext.sessionId,
            reason: terminalFailureGuard.reason,
            failureSignature: terminalFailureGuard.failureSignature,
          });
          observation = this.applyTerminalFailureGuard(observation, terminalFailureGuard);
        }

        lastObservation = observation;
        this.emitEvent(onEvent, {
          type: 'observation_complete',
          observation,
          timestamp: Date.now(),
        });

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
            { observation, finalState: state, summary },
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

  private enforceDestructiveApproval(plan: Plan): Plan {
    if (!this.config.requireApprovalForDestructiveActions || plan.requiresApproval) {
      return plan;
    }

    const destructiveSteps = plan.steps.filter((step) => this.isDestructiveTool(step.tool));
    if (destructiveSteps.length === 0) {
      return plan;
    }

    logger.info('Destructive plan detected, forcing approval', {
      destructiveTools: destructiveSteps.map((step) => step.tool),
    });

    return {
      ...plan,
      requiresApproval: true,
      rollbackStrategy:
        plan.rollbackStrategy && plan.rollbackStrategy.trim().length > 0
          ? plan.rollbackStrategy
          : 'Use undo stack to roll back destructive operations',
    };
  }

  private isDestructiveTool(toolName: string): boolean {
    const normalizedToolName = toolName.toLowerCase();
    const configured = this.config.destructiveToolNames.map((name) => name.toLowerCase());
    if (configured.includes(normalizedToolName)) {
      return true;
    }

    return (
      normalizedToolName.startsWith('delete_') ||
      normalizedToolName.startsWith('remove_') ||
      normalizedToolName.includes('ripple_delete')
    );
  }

  private async attemptRollback(
    executionResults: ExecutionResult[],
    executionContext: ExecutionContext,
  ): Promise<RollbackReport> {
    if (!this.config.enableAutoRollbackOnFailure) {
      return {
        attempted: false,
        candidateCount: 0,
        attemptedCount: 0,
        succeededCount: 0,
        failedCount: 0,
        skippedCount: 0,
        reason: 'Auto rollback is disabled by configuration',
        failures: [],
      };
    }

    const rollbackCandidates = this.collectRollbackCandidates(executionResults);
    if (rollbackCandidates.length === 0) {
      return {
        attempted: false,
        candidateCount: 0,
        attemptedCount: 0,
        succeededCount: 0,
        failedCount: 0,
        skippedCount: 0,
        reason: 'No undoable operations were recorded',
        failures: [],
      };
    }

    const limitedCandidates = rollbackCandidates.slice(0, this.config.maxRollbackSteps);
    const report: RollbackReport = {
      attempted: true,
      candidateCount: rollbackCandidates.length,
      attemptedCount: 0,
      succeededCount: 0,
      failedCount: 0,
      skippedCount: 0,
      reason:
        rollbackCandidates.length > limitedCandidates.length
          ? `Rollback limited to ${limitedCandidates.length} operations`
          : undefined,
      failures: [],
    };

    for (const candidate of limitedCandidates) {
      if (!this.toolExecutor.hasTool(candidate.undoTool)) {
        report.skippedCount += 1;
        report.failures.push({
          tool: candidate.undoTool,
          sourceStepId: candidate.sourceStepId,
          error: `Undo tool '${candidate.undoTool}' is not available`,
        });
        continue;
      }

      const validation = this.toolExecutor.validateArgs(candidate.undoTool, candidate.undoArgs);
      if (!validation.valid) {
        report.skippedCount += 1;
        report.failures.push({
          tool: candidate.undoTool,
          sourceStepId: candidate.sourceStepId,
          error: validation.errors.join(', '),
        });
        continue;
      }

      report.attemptedCount += 1;
      try {
        const undoResult = await this.toolExecutor.execute(
          candidate.undoTool,
          candidate.undoArgs,
          executionContext,
        );

        if (undoResult.success) {
          report.succeededCount += 1;
        } else {
          report.failedCount += 1;
          report.failures.push({
            tool: candidate.undoTool,
            sourceStepId: candidate.sourceStepId,
            error: undoResult.error ?? 'Undo operation failed',
          });
        }
      } catch (error) {
        report.failedCount += 1;
        report.failures.push({
          tool: candidate.undoTool,
          sourceStepId: candidate.sourceStepId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return report;
  }

  private collectRollbackCandidates(executionResults: ExecutionResult[]): Array<{
    sourceStepId: string;
    undoTool: string;
    undoArgs: Record<string, unknown>;
  }> {
    const candidates: Array<{
      sourceStepId: string;
      undoTool: string;
      undoArgs: Record<string, unknown>;
    }> = [];

    for (let resultIndex = executionResults.length - 1; resultIndex >= 0; resultIndex -= 1) {
      const executionResult = executionResults[resultIndex];

      for (
        let stepIndex = executionResult.completedSteps.length - 1;
        stepIndex >= 0;
        stepIndex -= 1
      ) {
        const step = executionResult.completedSteps[stepIndex];
        const undoOperation = step.result.undoOperation;
        if (!step.result.undoable || !undoOperation) {
          continue;
        }

        candidates.push({
          sourceStepId: step.stepId,
          undoTool: undoOperation.tool,
          undoArgs: undoOperation.args,
        });
      }
    }

    return candidates;
  }

  private emitEvent(onEvent: ((event: AgentEvent) => void) | undefined, event: AgentEvent): void {
    if (!onEvent) return;
    try {
      onEvent(event);
    } catch (error) {
      logger.error('Error in agent event handler', { error });
    }
  }

  private async hydrateContextWithMemory(agentContext: AgentContext): Promise<AgentContext> {
    if (!this.memoryStore) {
      return agentContext;
    }

    try {
      const [recentOperations, userPreferences, corrections] = await Promise.all([
        this.memoryStore.getRecentOperations(this.config.memoryRecentOperationsLimit),
        this.memoryStore.getPreferences(),
        this.memoryStore.getCorrections(this.config.memoryCorrectionsLimit),
      ]);

      return {
        ...agentContext,
        recentOperations:
          agentContext.recentOperations.length > 0
            ? agentContext.recentOperations
            : recentOperations,
        userPreferences: {
          ...userPreferences.custom,
          ...userPreferences,
          ...agentContext.userPreferences,
        },
        corrections: agentContext.corrections.length > 0 ? agentContext.corrections : corrections,
      };
    } catch (error) {
      logger.warn('Failed to hydrate memory context, using input context only', {
        error: error instanceof Error ? error.message : String(error),
      });
      return agentContext;
    }
  }

  private async recordExecutionOperations(
    executionResult: ExecutionResult,
    projectId: string,
  ): Promise<void> {
    const memoryStore = this.memoryStore;
    if (!memoryStore) {
      return;
    }

    const operationNames = [
      ...executionResult.completedSteps.map((step) => step.tool),
      ...executionResult.failedSteps.map((step) => step.tool),
    ];

    if (operationNames.length === 0) {
      return;
    }

    try {
      await Promise.all(
        operationNames.map((operation) => memoryStore.recordOperation(operation, projectId)),
      );
    } catch (error) {
      logger.warn('Failed to record operation usage in memory store', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private applyTerminalFailureGuard(
    observation: Observation,
    guidance: TerminalFailureGuidance,
  ): Observation {
    const guardSummary = `Stopped automatic retries: ${guidance.reason}`;
    const summary = observation.summary.includes('Stopped automatic retries')
      ? observation.summary
      : `${observation.summary} ${guardSummary}`.trim();

    const hasSuggestedAction =
      typeof observation.suggestedAction === 'string' &&
      observation.suggestedAction.trim().length > 0;

    return {
      ...observation,
      goalAchieved: false,
      needsIteration: false,
      iterationReason: guidance.reason,
      suggestedAction: hasSuggestedAction ? observation.suggestedAction : guidance.suggestedAction,
      summary,
      confidence: Math.max(observation.confidence, 0.9),
    };
  }

  private finalizeState(state: AgentState, phase: AgentPhase): AgentState {
    return {
      ...state,
      phase,
      completedAt: Date.now(),
    };
  }

  private createSummary(
    state: AgentState,
    durationMs: number,
    options: {
      failureReason?: string;
      rollbackReport?: RollbackReport;
    } = {},
  ): SessionSummary {
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
      failureReason: options.failureReason,
      rollbackReport: options.rollbackReport,
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
    options: Partial<
      Omit<AgentRunResult, 'success' | 'executionResults' | 'iterations' | 'totalDuration'>
    > & {
      finalState: AgentState;
    },
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
      rollbackReport: options.rollbackReport,
    };
  }
}

// =============================================================================
// Factory
// =============================================================================

export function createAgenticEngine(
  llm: ILLMClient,
  toolExecutor: IToolExecutor,
  config?: Partial<AgenticEngineConfig>,
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
