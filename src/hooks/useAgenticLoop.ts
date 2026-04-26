/**
 * useAgenticLoop Hook
 *
 * Main hook for orchestrating the AgenticEngine.
 * Provides React integration for the Think-Plan-Act-Observe loop.
 *
 * @example
 * ```tsx
 * function AIChat() {
 *   const { run, abort, phase, events, isRunning } = useAgenticLoop({
 *     onEvent: (event) => console.log(event),
 *     onComplete: (result) => console.log('Done!', result),
 *   });
 *
 *   return (
 *     <div>
 *       <button onClick={() => run('Split clip at 5 seconds')} disabled={isRunning}>
 *         Run
 *       </button>
 *       {isRunning && <button onClick={abort}>Cancel</button>}
 *       <div>Phase: {phase}</div>
 *     </div>
 *   );
 * }
 * ```
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import {
  createAgenticEngine,
  createEmptyContext,
  type AgentEvent,
  type AgentRunResult,
  type AgenticEngineConfig,
  type IMemoryStore,
  type ILLMClient,
  type IToolExecutor,
  type AgentPhase,
  type AgentContext,
  type LLMMessage,
  type Thought,
  type Plan,
  type PlanStep,
  createMemoryManagerAdapter,
  DEFAULT_AGENT_PROFILE_ID,
  generateId,
} from '@/agents/engine';
import { createScopedToolExecutor } from '@/agents/engine/adapters/tools/ScopedToolExecutor';
import {
  getAllowedToolNamesForAgent,
  resolveAgentDefinition,
} from '@/agents/engine/core/agentCatalog';
import { isAgenticEngineEnabled } from '@/config/featureFlags';
import { useConversationStore } from '@/stores/conversationStore';
import { usePermissionStore } from '@/stores/permissionStore';
import { clearPendingApprovals } from '@/hooks/useAgentApproval';
import { registerAgentAbort, unregisterAgentAbort } from '@/agents/engine/core/agentCleanup';
import {
  buildPermissionTraceRecord,
  persistPermissionAudit,
} from '@/agents/engine/core/permissionAudit';
import {
  mergeTraceArtifacts,
  TraceRecorder,
  type AgentTrace,
} from '@/agents/engine/core/traceRecorder';
import { writeTrace } from '@/agents/engine/core/traceWriter';
import {
  bootstrapPersistedAgentSession,
  bootstrapRecoveredContextFromCheckpoint,
  createResumeCheckpointController,
  ensureConfiguredProvider,
  ensureConversationSessionId,
  finalizePersistedRun,
  getPersistedSessionTraceState,
  startPersistedRun,
} from './agentRuntimePersistence';
import { useAgentRuntimeStoreContext } from './agentRuntimeStoreContext';
import { createLogger } from '@/services/logger';
import { useProjectStore } from '@/stores';

const logger = createLogger('useAgenticLoop');
const CONTEXT_HISTORY_LIMIT = 30;

// =============================================================================
// Types
// =============================================================================

/**
 * Options for useAgenticLoop hook
 */
export interface UseAgenticLoopOptions {
  /** LLM client to use */
  llmClient: ILLMClient;
  /** Tool executor to use */
  toolExecutor: IToolExecutor;
  /** Engine configuration */
  config?: Partial<AgenticEngineConfig>;
  /** Additional context to include */
  context?: Partial<AgentContext>;

  // Callbacks
  /** Called for each event */
  onEvent?: (event: AgentEvent) => void;
  /** Called when run completes */
  onComplete?: (result: AgentRunResult) => void;
  /** Called on error */
  onError?: (error: Error) => void;
  /** Called when approval is required */
  onApprovalRequired?: (plan: Plan) => void;
  /** Called on abort */
  onAbort?: () => void;
}

/**
 * Return type for useAgenticLoop hook
 */
export interface UseAgenticLoopReturn {
  // State
  /** Current phase */
  phase: AgentPhase;
  /** Whether the engine is running */
  isRunning: boolean;
  /** All events from current/last run */
  events: AgentEvent[];
  /** Error if any */
  error: Error | null;
  /** Current thought (if available) */
  thought: Thought | null;
  /** Current plan (if available) */
  plan: Plan | null;
  /** Pending clarification question awaiting a follow-up user reply */
  pendingClarificationQuestion: string | null;
  /** Pending per-tool permission request awaiting a user decision */
  pendingToolPermissionStep: PlanStep | null;
  /** Session ID */
  sessionId: string | null;

  // Actions
  /** Start a new run */
  run: (input: string) => Promise<AgentRunResult | null>;
  /** Abort current run */
  abort: () => void;
  /** Reset state */
  reset: () => void;
  /** Approve pending plan */
  approvePlan: () => void;
  /** Reject pending plan with optional feedback */
  rejectPlan: (reason?: string) => void;
  /** Respond to a tool permission request */
  approveToolPermission: (decision: 'allow' | 'deny' | 'allow_always') => void;
  /** Retry with last user input */
  retry: () => Promise<AgentRunResult | null>;

  // Feature flag
  /** Whether the agentic engine is enabled */
  isEnabled: boolean;
}

// =============================================================================
// Hook Implementation
// =============================================================================

/**
 * Main hook for using the AgenticEngine in React components.
 */
export function useAgenticLoop(options: UseAgenticLoopOptions): UseAgenticLoopReturn {
  const { llmClient, toolExecutor, config, context: externalContext } = options;

  // State
  const [phase, setPhase] = useState<AgentPhase>('idle');
  const [isRunning, setIsRunning] = useState(false);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [error, setError] = useState<Error | null>(null);
  const [thought, setThought] = useState<Thought | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [pendingClarificationQuestion, setPendingClarificationQuestion] = useState<string | null>(
    null,
  );
  const [pendingToolPermissionStep, setPendingToolPermissionStep] = useState<PlanStep | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);

  // Refs
  const engineRef = useRef<ReturnType<typeof createAgenticEngine> | null>(null);
  const abortedRef = useRef(false);
  const runGuardRef = useRef(false);
  const approvalResolverRef = useRef<{
    resolve: (result: { approved: boolean; feedback?: string }) => void;
  } | null>(null);
  const toolPermissionResolverRef = useRef<{
    resolve: (decision: 'allow' | 'deny' | 'allow_always') => void;
    step: unknown;
  } | null>(null);
  const bootstrappedCheckpointIdRef = useRef<string | null>(null);
  const memoryStoreRef = useRef<IMemoryStore | null>(null);
  const persistedRunIdRef = useRef<string | null>(null);
  const safeCheckpointIdRef = useRef<string | null>(null);
  const latestPlanRef = useRef<Plan | null>(null);

  if (!memoryStoreRef.current && config?.enableMemory !== false) {
    memoryStoreRef.current = createMemoryManagerAdapter();
  }

  // Options ref to avoid stale closures
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  }, [options]);

  // Check if feature is enabled (with fallback for test environments)
  const isEnabled = typeof isAgenticEngineEnabled === 'function' ? isAgenticEngineEnabled() : false;

  // Build context
  const buildContext = useCallback((): AgentContext => {
    const projectId = externalContext?.projectId ?? 'unknown';
    const base = createEmptyContext(projectId);

    return {
      ...base,
      ...externalContext,
      projectId,
    };
  }, [externalContext]);

  // Handle event
  const handleEvent = useCallback((event: AgentEvent) => {
    // Add to events list
    setEvents((prev) => [...prev, event]);

    // Update state based on event type
    switch (event.type) {
      case 'session_start':
        setSessionId(event.sessionId);
        break;

      case 'thinking_start':
        setPhase('thinking');
        break;

      case 'planning_start':
        setPhase('planning');
        break;

      case 'approval_required':
        setPhase('awaiting_approval');
        setPlan(event.plan);
        latestPlanRef.current = event.plan;
        // Trigger callback and wait for response
        optionsRef.current.onApprovalRequired?.(event.plan);
        break;

      case 'clarification_required':
        setPendingClarificationQuestion(event.question);
        break;

      case 'tool_permission_request':
        setPendingToolPermissionStep(event.step);
        break;

      case 'tool_permission_response':
        setPendingToolPermissionStep(null);
        break;

      case 'thinking_complete':
        setThought(event.thought);
        break;

      case 'planning_complete':
        setPlan(event.plan);
        latestPlanRef.current = event.plan;
        break;

      case 'execution_start':
        setPhase('executing');
        break;

      case 'observation_complete':
        setPhase('observing');
        break;

      case 'session_complete':
        setIsRunning(false);
        setPhase('completed');
        setPendingToolPermissionStep(null);
        break;

      case 'session_aborted':
        setIsRunning(false);
        setPhase('aborted');
        setPendingClarificationQuestion(null);
        setPendingToolPermissionStep(null);
        break;

      case 'session_failed':
        setError(event.error);
        setPhase('failed');
        setIsRunning(false);
        setPendingClarificationQuestion(null);
        setPendingToolPermissionStep(null);
        optionsRef.current.onError?.(event.error);
        break;
    }

    // Call external event handler
    optionsRef.current.onEvent?.(event);
  }, []);

  // Run the engine
  const run = useCallback(
    async (input: string): Promise<AgentRunResult | null> => {
      if (!isEnabled) {
        const disabledError = new Error(
          'Agentic engine is disabled via feature flag. Enable USE_AGENTIC_ENGINE to run agent workflows.',
        );
        setError(disabledError);
        setPhase('failed');
        optionsRef.current.onError?.(disabledError);
        logger.warn('Agentic engine is disabled via feature flag');
        return null;
      }

      if (runGuardRef.current) {
        logger.warn('Engine is already running');
        return null;
      }
      runGuardRef.current = true;
      persistedRunIdRef.current = null;
      safeCheckpointIdRef.current = null;

      // Reset state
      setIsRunning(true);
      setEvents([]);
      setError(null);
      setThought(null);
      setPlan(null);
      latestPlanRef.current = null;
      setPendingClarificationQuestion(null);
      setPendingToolPermissionStep(null);
      setPhase('thinking');
      abortedRef.current = false;

      // Pre-flight: verify AI provider is configured
      // For refreshable clients (e.g., Tauri adapter), refresh backend status first
      // to avoid false negatives from stale in-memory cache.
      const providerConfigured = await ensureConfiguredProvider(llmClient, logger, 'agentic');
      if (!providerConfigured) {
        const configError = new Error(
          'AI provider not configured. Go to Settings > AI to set up your API key.',
        );
        setError(configError);
        setPhase('failed');
        setIsRunning(false);
        optionsRef.current.onError?.(configError);
        logger.error('Pre-flight check failed: AI provider not configured');
        runGuardRef.current = false;
        return null;
      }

      // Build context
      const context = buildContext();

      // Ensure a conversation session exists before running
      const convStore = useConversationStore.getState();
      const contextProjectId =
        context.projectId && context.projectId !== 'current' && context.projectId !== 'unknown'
          ? context.projectId
          : null;
      const bootstrapProjectId = useProjectStore.getState().meta?.id ?? contextProjectId;
      if (!convStore.activeProjectId && bootstrapProjectId) {
        convStore.loadForProject(bootstrapProjectId);
      }

      const storeSessionId = await ensureConversationSessionId(useConversationStore.getState());
      if (!storeSessionId) {
        const sessionError = new Error(
          'Conversation session is required before starting agentic loop',
        );
        setError(sessionError);
        setPhase('failed');
        setIsRunning(false);
        optionsRef.current.onError?.(sessionError);
        logger.error('Failed to start agentic loop without conversation session');
        runGuardRef.current = false;
        return null;
      }

      const projectId = convStore.activeProjectId ?? context.projectId;
      const activeSessionSummary = convStore.sessions.find(
        (session) => session.id === storeSessionId,
      );
      const activeAgentDefinition =
        resolveAgentDefinition(activeSessionSummary?.agent) ??
        resolveAgentDefinition(DEFAULT_AGENT_PROFILE_ID);
      if (!activeAgentDefinition) {
        const definitionError = new Error('Default agent definition is not registered');
        setError(definitionError);
        setPhase('failed');
        setIsRunning(false);
        optionsRef.current.onError?.(definitionError);
        logger.error('Failed to start agentic loop without a registered default agent');
        runGuardRef.current = false;
        return null;
      }
      const scopedToolExecutor = createScopedToolExecutor(
        toolExecutor,
        getAllowedToolNamesForAgent(activeAgentDefinition, toolExecutor.getAvailableTools()),
      );
      const persistedTraceId = config?.enableTracing === false ? null : generateId('trace');
      const runtimeTraceRecorder = persistedTraceId ? new TraceRecorder() : null;
      runtimeTraceRecorder?.startRun({
        sessionId: storeSessionId,
        input,
        model: config?.activeModel,
        provider: config?.activeProvider,
        traceId: persistedTraceId ?? undefined,
        runtimeKind: 'tpao',
      });
      const checkpointController = createResumeCheckpointController({
        sessionId: storeSessionId,
        persistedRunIdRef,
        logger,
        loggerLabel: 'agentic',
        onCheckpointPersisted: (record) => runtimeTraceRecorder?.recordCheckpointEvent(record),
        onCheckpointConsumed: (record) => runtimeTraceRecorder?.recordCheckpointEvent(record),
      });
      await bootstrapPersistedAgentSession({
        sessionId: storeSessionId,
        projectId,
        sequenceId: context.sequenceId ?? null,
        runtimeKind: 'tpao',
        agentProfileId: activeAgentDefinition?.id,
        modelProvider: config?.activeProvider ?? null,
        modelId: config?.activeModel ?? null,
        logger,
        loggerLabel: 'agentic',
      });
      const recoveredExecutableResume = await bootstrapRecoveredContextFromCheckpoint({
        sessionId: storeSessionId,
        addSystemMessageToSession: convStore.addSystemMessageToSession,
        logger,
        loggerLabel: 'agentic',
        lastBootstrappedCheckpointIdRef: bootstrappedCheckpointIdRef,
        onCheckpointRecovered: (record) => runtimeTraceRecorder?.recordCheckpointEvent(record),
        onCompactionRecovered: (record) => runtimeTraceRecorder?.recordCompactionEvent(record),
      });
      const recoveredApprovalResume =
        recoveredExecutableResume?.kind === 'approval_wait' ? recoveredExecutableResume : null;
      const recoveredToolWaitResume =
        recoveredExecutableResume?.kind === 'tool_wait' &&
        typeof context.projectStateVersion === 'number' &&
        recoveredExecutableResume.projectStateVersion === context.projectStateVersion
          ? recoveredExecutableResume
          : null;

      // Create execution context bound to the store session
      const executionContext = {
        projectId: context.projectId,
        sequenceId: context.sequenceId,
        sessionId: storeSessionId,
        traceId: persistedTraceId ?? undefined,
        expectedStateVersion: context.projectStateVersion,
      };

      let persistedFinalPhase: 'completed' | 'failed' | 'aborted' = 'completed';
      let persistedErrorMessage: string | null = null;
      let persistedToolCalls = 0;
      let persistedCompletedStepCount = 0;
      let persistedPlannedStepCount: number | undefined;
      let persistedRollbackReportJson: string | null = null;
      let traceToWrite: AgentTrace | null = null;
      let finalizedRuntimeTrace: AgentTrace | null = null;

      const finalizeRuntimeTrace = (
        success: boolean,
        errorMessage?: string | null,
      ): AgentTrace | null => {
        if (!runtimeTraceRecorder) {
          return null;
        }

        if (!finalizedRuntimeTrace) {
          finalizedRuntimeTrace = runtimeTraceRecorder.finalize(success, errorMessage ?? undefined);
        }

        return finalizedRuntimeTrace;
      };

      const startedRunId = await startPersistedRun({
        sessionId: executionContext.sessionId,
        runtimeKind: 'tpao',
        trigger: recoveredApprovalResume || recoveredToolWaitResume ? 'resume' : 'user',
        maxIterations: config?.maxIterations,
        maxToolCalls: config?.maxToolCallsPerRun,
        traceId: persistedTraceId,
        runInput: recoveredApprovalResume?.input ?? recoveredToolWaitResume?.input ?? input,
        context,
        checkpointController,
        persistedRunIdRef,
        safeCheckpointIdRef,
        logger,
        loggerLabel: 'agentic',
      });
      runtimeTraceRecorder?.setArtifactState({
        persistedRunId: startedRunId,
      });

      try {
        const baseApprovalHandler =
          config?.approvalHandler ??
          (async () => {
            return await new Promise<{ approved: boolean; feedback?: string }>((resolve) => {
              approvalResolverRef.current = { resolve };
            });
          });
        const baseToolPermissionHandler =
          config?.toolPermissionHandler ??
          (async (toolName, args, step) => {
            const resolution = usePermissionStore
              .getState()
              .resolvePermissionDetails(toolName, args);
            const stepId = typeof step.id === 'string' ? step.id : null;

            if (resolution.permission === 'allow' || resolution.permission === 'deny') {
              runtimeTraceRecorder?.recordPermissionEvent(
                buildPermissionTraceRecord({
                  runId: persistedRunIdRef.current,
                  stepId,
                  resolution,
                  action: resolution.permission,
                }),
              );
              persistPermissionAudit(
                storeSessionId,
                persistedRunIdRef.current,
                stepId,
                resolution,
                resolution.permission,
              );
              return resolution.permission;
            }

            runtimeTraceRecorder?.recordPermissionEvent(
              buildPermissionTraceRecord({
                runId: persistedRunIdRef.current,
                stepId,
                resolution,
                action: 'ask',
              }),
            );
            persistPermissionAudit(
              storeSessionId,
              persistedRunIdRef.current,
              stepId,
              resolution,
              'ask',
            );

            const decision = await new Promise<'allow' | 'deny' | 'allow_always'>((resolve) => {
              toolPermissionResolverRef.current = {
                resolve,
                step,
              };
            });

            runtimeTraceRecorder?.recordPermissionEvent(
              buildPermissionTraceRecord({
                runId: persistedRunIdRef.current,
                stepId,
                resolution,
                action: decision,
                source: 'interactive_approval',
              }),
            );
            persistPermissionAudit(
              storeSessionId,
              persistedRunIdRef.current,
              stepId,
              resolution,
              decision,
              'interactive_approval',
            );

            return decision;
          });

        // Create engine
        const engine = createAgenticEngine(llmClient, scopedToolExecutor, {
          ...config,
          role: activeAgentDefinition?.role ?? 'editor',
          writeTraceOnComplete: false,
          memoryStore: config?.memoryStore ?? memoryStoreRef.current ?? undefined,
          approvalHandler: async (plan) => {
            if (recoveredApprovalResume?.checkpointId) {
              try {
                return await baseApprovalHandler(plan);
              } finally {
                await checkpointController.consumeCheckpoint(recoveredApprovalResume.checkpointId);
              }
            }

            const checkpointId = await checkpointController.persistCheckpoint({
              sessionId: storeSessionId,
              runId: persistedRunIdRef.current,
              runtimeKind: 'tpao',
              checkpointKind: 'approval_wait',
              phase: 'awaiting_approval',
              projectId: context.projectId,
              sequenceId: context.sequenceId ?? null,
              input,
              planGoal: plan.goal,
              planStepIds: plan.steps.map((step) => step.id),
              plan,
            });

            try {
              return await baseApprovalHandler(plan);
            } finally {
              await checkpointController.consumeCheckpoint(checkpointId);
            }
          },
          toolPermissionHandler: async (toolName, args, step) => {
            const activePlan = latestPlanRef.current;
            const stepIndex =
              activePlan?.steps.findIndex((candidate) => candidate.id === step.id) ?? -1;

            if (
              recoveredToolWaitResume?.checkpointId &&
              step.id === recoveredToolWaitResume.stepId
            ) {
              try {
                return await baseToolPermissionHandler(toolName, args, step);
              } finally {
                await checkpointController.consumeCheckpoint(recoveredToolWaitResume.checkpointId);
              }
            }

            const decisionPromise = baseToolPermissionHandler(toolName, args, step);
            let autoResolved = false;
            let autoDecision: 'allow' | 'deny' | 'allow_always' | undefined;

            void decisionPromise.then((decision) => {
              if (!autoResolved) {
                autoResolved = true;
                autoDecision = decision;
              }
            });

            await Promise.resolve();

            let checkpointId: string | null = null;
            if (!autoResolved) {
              checkpointId = await checkpointController.persistCheckpoint({
                sessionId: storeSessionId,
                runId: persistedRunIdRef.current,
                runtimeKind: 'tpao',
                checkpointKind: 'tool_wait',
                phase: 'awaiting_tool_permission',
                projectId: context.projectId,
                sequenceId: context.sequenceId ?? null,
                projectStateVersion: context.projectStateVersion ?? null,
                input,
                plan: activePlan,
                nextStepIndex: stepIndex >= 0 ? stepIndex : null,
                completedStepIds: stepIndex === 0 ? [] : null,
                toolCallsUsed: stepIndex === 0 ? 0 : null,
                stepId: typeof step.id === 'string' ? step.id : null,
                toolName,
                args,
              });
              autoResolved = true;
            }

            try {
              return autoDecision ?? (await decisionPromise);
            } finally {
              await checkpointController.consumeCheckpoint(checkpointId);
            }
          },
        });
        engineRef.current = engine;

        // Get conversation history for multi-turn context
        const rawHistory = useConversationStore
          .getState()
          .getMessagesForContext(CONTEXT_HISTORY_LIMIT);
        const conversationHistory = trimDuplicatedTailUserMessageForContext(rawHistory, input);

        // Run engine with conversation history
        const result = recoveredApprovalResume
          ? await engine.resumePendingApproval(
              recoveredApprovalResume.input,
              recoveredApprovalResume.plan,
              context,
              executionContext,
              handleEvent,
            )
          : recoveredToolWaitResume
            ? await engine.resumePendingToolPermission(
                recoveredToolWaitResume.input,
                recoveredToolWaitResume.plan,
                context,
                executionContext,
                handleEvent,
              )
            : await engine.run(input, context, executionContext, handleEvent, conversationHistory);

        persistedFinalPhase =
          result.finalState.phase === 'aborted'
            ? 'aborted'
            : result.finalState.phase === 'failed'
              ? 'failed'
              : 'completed';
        persistedErrorMessage = result.error?.message ?? null;
        persistedToolCalls = result.executionResults.reduce(
          (count, executionResult) => count + executionResult.toolCallsUsed,
          0,
        );
        persistedCompletedStepCount = result.executionResults.reduce(
          (count, executionResult) => count + executionResult.completedSteps.length,
          0,
        );
        persistedPlannedStepCount =
          result.pendingPlan?.steps.length ?? result.finalState.plan?.steps.length;
        persistedRollbackReportJson = result.rollbackReport
          ? JSON.stringify(result.rollbackReport)
          : null;
        const runtimeTrace = finalizeRuntimeTrace(result.success, result.error?.message ?? null);
        const enrichedResult =
          runtimeTrace && result.trace
            ? { ...result, trace: mergeTraceArtifacts(result.trace, runtimeTrace) }
            : runtimeTrace
              ? { ...result, trace: runtimeTrace }
              : result;
        traceToWrite = enrichedResult.trace ?? null;

        if (!abortedRef.current) {
          setPhase(enrichedResult.finalState.phase);
          optionsRef.current.onComplete?.(enrichedResult);
        }

        return enrichedResult;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        persistedFinalPhase = 'failed';
        persistedErrorMessage = error.message;
        traceToWrite = finalizeRuntimeTrace(false, error.message);
        setError(error);
        setPhase('failed');
        optionsRef.current.onError?.(error);
        logger.error('Engine run failed', { error: error.message });
        throw error;
      } finally {
        const persistedRunId = persistedRunIdRef.current;
        const safeCheckpointId = safeCheckpointIdRef.current;
        persistedRunIdRef.current = null;
        safeCheckpointIdRef.current = null;
        if (persistedRunId) {
          await finalizePersistedRun({
            sessionId: executionContext.sessionId,
            runId: persistedRunId,
            phase: abortedRef.current ? 'aborted' : persistedFinalPhase,
            traceId: persistedTraceId,
            toolCallsUsed: persistedToolCalls,
            plannedStepCount: persistedPlannedStepCount,
            completedStepCount: persistedCompletedStepCount,
            rollbackReportJson: persistedRollbackReportJson,
            errorMessage: persistedErrorMessage,
            logger,
            loggerLabel: 'agentic',
          });
        }
        await checkpointController.consumeCheckpoint(safeCheckpointId);
        if (traceToWrite) {
          traceToWrite = {
            ...traceToWrite,
            artifacts: {
              ...traceToWrite.artifacts,
              ...getPersistedSessionTraceState(executionContext.sessionId),
              persistedRunId: persistedRunId ?? traceToWrite.artifacts.persistedRunId,
            },
          };
          await writeTrace(traceToWrite);
        }

        runGuardRef.current = false;
        setIsRunning(false);
        engineRef.current = null;
      }
    },
    [isEnabled, llmClient, toolExecutor, config, buildContext, handleEvent],
  );

  const cleanupAbort = useCallback(() => {
    abortedRef.current = true;
    engineRef.current?.abort();
    // Unblock pending promises so the engine can finish aborting.
    // Reject approval and deny tool permissions to prevent execution of
    // any pending plan steps after the abort signal.
    approvalResolverRef.current?.resolve({ approved: false, feedback: 'Aborted by user' });
    approvalResolverRef.current = null;
    toolPermissionResolverRef.current?.resolve('deny');
    toolPermissionResolverRef.current = null;
    clearPendingApprovals();
  }, []);

  // Abort
  const abort = useCallback(() => {
    cleanupAbort();
    setPhase('aborted');
    optionsRef.current.onAbort?.();
    logger.info('Engine aborted by user');
  }, [cleanupAbort]);

  // Reset
  const reset = useCallback(() => {
    abortedRef.current = false;
    runGuardRef.current = false;
    engineRef.current = null;
    approvalResolverRef.current = null;
    clearPendingApprovals();
    bootstrappedCheckpointIdRef.current = null;
    persistedRunIdRef.current = null;
    safeCheckpointIdRef.current = null;
    setPhase('idle');
    setIsRunning(false);
    setEvents([]);
    setError(null);
    setThought(null);
    setPlan(null);
    latestPlanRef.current = null;
    setPendingClarificationQuestion(null);
    setPendingToolPermissionStep(null);
    setSessionId(null);
  }, []);

  // Approval actions
  const approvePlan = useCallback(() => {
    approvalResolverRef.current?.resolve({ approved: true });
    approvalResolverRef.current = null;
  }, []);

  const rejectPlan = useCallback((reason?: string) => {
    approvalResolverRef.current?.resolve({
      approved: false,
      feedback: reason,
    });
    approvalResolverRef.current = null;
  }, []);

  // Tool permission actions
  const approveToolPermission = useCallback((decision: 'allow' | 'deny' | 'allow_always') => {
    if (decision === 'allow_always' && toolPermissionResolverRef.current?.step) {
      const step = toolPermissionResolverRef.current.step as {
        tool?: string;
        args?: Record<string, unknown>;
      };
      if (step.tool) {
        usePermissionStore.getState().allowAlways(step.tool, step.args);
      }
    }
    toolPermissionResolverRef.current?.resolve(decision);
    toolPermissionResolverRef.current = null;
  }, []);

  // Retry with last user input
  const retry = useCallback(async (): Promise<AgentRunResult | null> => {
    const lastInput = useConversationStore.getState().getLastUserInput();
    if (!lastInput) {
      logger.warn('No previous input to retry');
      return null;
    }
    return run(lastInput);
  }, [run]);

  // Register abort for project-close cleanup; clean up on unmount
  useEffect(() => {
    registerAgentAbort(abort);
    return () => {
      unregisterAgentAbort();
      cleanupAbort();
    };
  }, [abort, cleanupAbort]);

  return {
    // State
    phase,
    isRunning,
    events,
    error,
    thought,
    plan,
    pendingClarificationQuestion,
    pendingToolPermissionStep,
    sessionId,

    // Actions
    run,
    abort,
    reset,
    approvePlan,
    rejectPlan,
    approveToolPermission,
    retry,

    // Feature flag
    isEnabled,
  };
}

// =============================================================================
// Helper Hook: useAgenticLoopWithStores
// =============================================================================

/**
 * Extended hook that integrates with global stores.
 * Reads playbackStore, timelineStore, projectStore to build real AgentContext.
 */
export function useAgenticLoopWithStores(
  options: Omit<UseAgenticLoopOptions, 'context'> & { context?: Partial<AgentContext> },
): UseAgenticLoopReturn {
  const { context, contextRefresher, aiMaxTokens, aiPrimaryModel, aiPrimaryProvider } =
    useAgentRuntimeStoreContext(options.context);

  return useAgenticLoop({
    ...options,
    context,
    config: {
      ...options.config,
      contextRefresher,
      maxOutputTokens: options.config?.maxOutputTokens ?? aiMaxTokens,
      activeModel: options.config?.activeModel ?? aiPrimaryModel ?? undefined,
      activeProvider: options.config?.activeProvider ?? aiPrimaryProvider ?? undefined,
    },
  });
}

export function trimDuplicatedTailUserMessageForContext(
  history: LLMMessage[],
  input: string,
): LLMMessage[] {
  if (!history || history.length === 0) {
    return history;
  }

  const last = history[history.length - 1];
  if (last.role === 'user' && last.content.trim() === input.trim()) {
    return history.slice(0, -1);
  }

  return history;
}
