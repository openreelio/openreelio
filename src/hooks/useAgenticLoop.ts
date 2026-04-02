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

import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import {
  createAgenticEngine,
  createEmptyContext,
  createLanguagePolicy,
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
  createMemoryManagerAdapter,
} from '@/agents/engine';
import { isAgenticEngineEnabled } from '@/config/featureFlags';
import { useConversationStore } from '@/stores/conversationStore';
import { usePermissionStore } from '@/stores/permissionStore';
import { usePlaybackStore } from '@/stores/playbackStore';
import { useTimelineStore } from '@/stores/timelineStore';
import { useProjectStore } from '@/stores';
import { useAgentSessionStore } from '@/stores/agentSessionStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { globalToolRegistry } from '@/agents';
import { clearPendingApprovals } from '@/hooks/useAgentApproval';
import { registerAgentAbort, unregisterAgentAbort } from '@/agents/engine/core/agentCleanup';
import { buildResumeCheckpointPayload } from '@/agents/engine/core/recoveryPersistence';
import { persistPermissionAudit } from '@/agents/engine/core/permissionAudit';
import { createLogger } from '@/services/logger';

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
  const memoryStoreRef = useRef<IMemoryStore | null>(null);
  const persistedRunIdRef = useRef<string | null>(null);

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
        // Trigger callback and wait for response
        optionsRef.current.onApprovalRequired?.(event.plan);
        break;

      case 'thinking_complete':
        setThought(event.thought);
        break;

      case 'planning_complete':
        setPlan(event.plan);
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
        break;

      case 'session_aborted':
        setIsRunning(false);
        setPhase('aborted');
        break;

      case 'session_failed':
        setError(event.error);
        setPhase('failed');
        setIsRunning(false);
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

      // Reset state
      setIsRunning(true);
      setEvents([]);
      setError(null);
      setThought(null);
      setPlan(null);
      setPhase('thinking');
      abortedRef.current = false;

      // Pre-flight: verify AI provider is configured
      // For refreshable clients (e.g., Tauri adapter), refresh backend status first
      // to avoid false negatives from stale in-memory cache.
      if (typeof llmClient.isConfigured === 'function' && !llmClient.isConfigured()) {
        const refreshableClient = llmClient as ILLMClient & {
          refreshStatus?: () => Promise<{ isConfigured: boolean }>;
        };

        if (typeof refreshableClient.refreshStatus === 'function') {
          try {
            await refreshableClient.refreshStatus();
          } catch (statusError) {
            logger.warn('Failed to refresh LLM provider status before run', {
              error: statusError instanceof Error ? statusError.message : String(statusError),
            });
          }
        }
      }

      if (typeof llmClient.isConfigured === 'function' && !llmClient.isConfigured()) {
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
      const storeSessionId = convStore.activeSessionId
        ?? await convStore.ensureSession();
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
      const agentSessionStore = useAgentSessionStore.getState();
      const persistResumeCheckpoint = async (inputOverrides: Parameters<
        typeof buildResumeCheckpointPayload
      >[0]): Promise<string | null> => {
        try {
          const sessionSnapshot = useAgentSessionStore.getState().snapshotsById[storeSessionId]?.session;
          const payload = buildResumeCheckpointPayload({
            currentPlanId: sessionSnapshot?.currentPlanId ?? null,
            pendingApprovalId: sessionSnapshot?.pendingApprovalId ?? null,
            ...inputOverrides,
          });
          const checkpoint = await agentSessionStore.createResumeCheckpoint({
            sessionId: storeSessionId,
            runId: persistedRunIdRef.current,
            checkpointKind: inputOverrides.checkpointKind,
            ...payload,
          });
          return checkpoint.id;
        } catch (error) {
          logger.warn('Failed to persist agentic resume checkpoint', {
            sessionId: storeSessionId,
            checkpointKind: inputOverrides.checkpointKind,
            error: error instanceof Error ? error.message : String(error),
          });
          return null;
        }
      };
      const consumeResumeCheckpoint = async (checkpointId: string | null): Promise<void> => {
        if (!checkpointId) {
          return;
        }

        try {
          await agentSessionStore.consumeResumeCheckpoint(checkpointId);
        } catch (error) {
          logger.warn('Failed to consume agentic resume checkpoint', {
            sessionId: storeSessionId,
            checkpointId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      };
      if (projectId) {
        agentSessionStore.loadForProject(projectId);

        try {
          await agentSessionStore.ensureSession({
            id: storeSessionId,
            projectId,
            sequenceId: context.sequenceId ?? null,
            runtimeKind: 'tpao',
            sessionMode: 'primary',
            agentProfileId: 'editor',
            modelProvider: config?.activeProvider ?? null,
            modelId: config?.activeModel ?? null,
          });
        } catch (error) {
          logger.warn('Failed to ensure persisted agentic session', {
            sessionId: storeSessionId,
            projectId,
            error: error instanceof Error ? error.message : String(error),
          });
        }

        try {
          const decisions = await agentSessionStore.refreshPermissionDecisions(storeSessionId);
          usePermissionStore
            .getState()
            .hydrateSessionRulesFromPersistedDecisions(storeSessionId, decisions);
        } catch (error) {
          logger.warn('Failed to replay persisted agentic permissions', {
            sessionId: storeSessionId,
            projectId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      // Create execution context bound to the store session
      const executionContext = {
        projectId: context.projectId,
        sequenceId: context.sequenceId,
        sessionId: storeSessionId,
        expectedStateVersion: context.projectStateVersion,
      };

      let persistedFinalPhase: 'completed' | 'failed' | 'aborted' = 'completed';
      let persistedErrorMessage: string | null = null;
      let persistedToolCalls = 0;

      try {
        const persistedRun = await agentSessionStore.startRun({
          sessionId: executionContext.sessionId,
          runtimeKind: 'tpao',
          trigger: 'user',
          maxIterations: config?.maxIterations,
          maxToolCalls: config?.maxToolCallsPerRun,
        });
        persistedRunIdRef.current = persistedRun.id;
        await persistResumeCheckpoint({
          sessionId: storeSessionId,
          runId: persistedRun.id,
          runtimeKind: 'tpao',
          checkpointKind: 'safe_resume_point',
          phase: 'initializing',
          projectId: context.projectId,
          sequenceId: context.sequenceId ?? null,
          input,
        });
      } catch (error) {
        persistedRunIdRef.current = null;
        logger.warn('Failed to create persisted agentic run', {
          sessionId: executionContext.sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }

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
              persistPermissionAudit(
                storeSessionId,
                persistedRunIdRef.current,
                stepId,
                resolution,
                resolution.permission,
              );
              return resolution.permission;
            }

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
        const engine = createAgenticEngine(llmClient, toolExecutor, {
          ...config,
          memoryStore: config?.memoryStore ?? memoryStoreRef.current ?? undefined,
          approvalHandler: async (plan) => {
            const checkpointId = await persistResumeCheckpoint({
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
            });

            try {
              return await baseApprovalHandler(plan);
            } finally {
              await consumeResumeCheckpoint(checkpointId);
            }
          },
          toolPermissionHandler: async (toolName, args, step) => {
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
              checkpointId = await persistResumeCheckpoint({
                sessionId: storeSessionId,
                runId: persistedRunIdRef.current,
                runtimeKind: 'tpao',
                checkpointKind: 'tool_wait',
                phase: 'awaiting_tool_permission',
                projectId: context.projectId,
                sequenceId: context.sequenceId ?? null,
                input,
                stepId: typeof step.id === 'string' ? step.id : null,
                toolName,
                args,
              });
              autoResolved = true;
            }

            try {
              return autoDecision ?? await decisionPromise;
            } finally {
              await consumeResumeCheckpoint(checkpointId);
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
        const result = await engine.run(
          input,
          context,
          executionContext,
          handleEvent,
          conversationHistory,
        );

        if (!abortedRef.current) {
          persistedFinalPhase =
            result.finalState.phase === 'aborted'
              ? 'aborted'
              : result.finalState.phase === 'failed'
                ? 'failed'
                : 'completed';
          persistedErrorMessage = result.error?.message ?? null;
          persistedToolCalls = result.finalState.executionHistory.length;
          setPhase(result.finalState.phase);
          optionsRef.current.onComplete?.(result);
        }

        return result;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        persistedFinalPhase = 'failed';
        persistedErrorMessage = error.message;
        setError(error);
        setPhase('failed');
        optionsRef.current.onError?.(error);
        logger.error('Engine run failed', { error: error.message });
        throw error;
      } finally {
        const persistedRunId = persistedRunIdRef.current;
        persistedRunIdRef.current = null;
        if (persistedRunId) {
          try {
            await agentSessionStore.updateRunPhase({
              runId: persistedRunId,
              phase: abortedRef.current ? 'aborted' : persistedFinalPhase,
              toolCallsUsed: persistedToolCalls,
              completedStepCount: persistedToolCalls,
              errorMessage: persistedErrorMessage,
              endedAt: Date.now(),
            });
          } catch (error) {
            logger.warn('Failed to finalize persisted agentic run', {
              runId: persistedRunId,
              phase: abortedRef.current ? 'aborted' : persistedFinalPhase,
              error: error instanceof Error ? error.message : String(error),
            });
          }
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
    setIsRunning(false);
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
    setPhase('idle');
    setIsRunning(false);
    setEvents([]);
    setError(null);
    setThought(null);
    setPlan(null);
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
  const externalContext = options.context;
  // Read from stores
  const currentTime = usePlaybackStore((s) => s.currentTime);
  const duration = usePlaybackStore((s) => s.duration);
  const selectedClipIds = useTimelineStore((s) => s.selectedClipIds);
  const selectedTrackIds = useTimelineStore((s) => s.selectedTrackIds);
  const activeSequenceId = useProjectStore((s) => s.activeSequenceId);
  const projectStateVersion = useProjectStore((s) => s.stateVersion);
  const sequences = useProjectStore((s) => s.sequences);
  const assets = useProjectStore((s) => s.assets);
  const uiLanguage = useSettingsStore((s) => s.settings.general.language);

  // Build real context from stores
  const context = useMemo((): Partial<AgentContext> => {
    const activeSequence = activeSequenceId ? sequences.get(activeSequenceId) : undefined;

    const storeContext: Partial<AgentContext> = {
      projectId: 'current',
      sequenceId: activeSequenceId ?? undefined,
      languagePolicy: createLanguagePolicy(uiLanguage),
      projectStateVersion,
      playheadPosition: currentTime,
      timelineDuration: duration,
      selectedClips: selectedClipIds,
      selectedTracks: selectedTrackIds,
      availableAssets: Array.from(assets.values())
        .filter((a) => a.kind === 'video' || a.kind === 'audio' || a.kind === 'image')
        .map((a) => ({
          id: a.id,
          name: a.name,
          type: a.kind as 'video' | 'audio' | 'image',
          duration: a.durationSec,
        })),
      availableTracks:
        activeSequence?.tracks.map((t) => ({
          id: t.id,
          name: t.name || `Track ${t.id}`,
          type: t.kind === 'audio' ? ('audio' as const) : ('video' as const),
          clipCount: t.clips.length,
        })) ?? [],
      availableTools: globalToolRegistry.listAll().map((t) => t.name),
    };
    return {
      ...storeContext,
      ...externalContext,
      projectId: externalContext?.projectId ?? storeContext.projectId,
    };
  }, [
    currentTime,
    duration,
    selectedClipIds,
    selectedTrackIds,
    activeSequenceId,
    projectStateVersion,
    sequences,
    assets,
    uiLanguage,
    externalContext,
  ]);

  // Build a contextRefresher that reads fresh state from stores each iteration.
  // Returns only the fields that may change between iterations (timeline/playback state).
  // Memory fields (recentOperations, userPreferences, corrections) and availableTools
  // are preserved from the previous iteration by the engine's spread-merge logic.
  const contextRefresher = useCallback((): Partial<AgentContext> => {
    const playback = usePlaybackStore.getState();
    const timeline = useTimelineStore.getState();
    const project = useProjectStore.getState();
    const settings = useSettingsStore.getState();

    const activeSeq = project.activeSequenceId
      ? project.sequences.get(project.activeSequenceId)
      : undefined;

    return {
      projectId: externalContext?.projectId ?? 'current',
      sequenceId: project.activeSequenceId ?? undefined,
      languagePolicy: createLanguagePolicy(settings.settings.general.language),
      projectStateVersion: project.stateVersion,
      playheadPosition: playback.currentTime,
      timelineDuration: playback.duration,
      selectedClips: timeline.selectedClipIds,
      selectedTracks: timeline.selectedTrackIds,
      availableAssets: Array.from(project.assets.values())
        .filter((a) => a.kind === 'video' || a.kind === 'audio' || a.kind === 'image')
        .map((a) => ({
          id: a.id,
          name: a.name,
          type: a.kind as 'video' | 'audio' | 'image',
          duration: a.durationSec,
        })),
      availableTracks:
        activeSeq?.tracks.map((t) => ({
          id: t.id,
          name: t.name || `Track ${t.id}`,
          type: t.kind === 'audio' ? ('audio' as const) : ('video' as const),
          clipCount: t.clips.length,
        })) ?? [],
    };
  }, [externalContext?.projectId]);

  // Read AI settings for model-aware token budget resolution
  const aiMaxTokens = useSettingsStore((s) => s.settings.ai.maxTokens);
  const aiPrimaryModel = useSettingsStore((s) => s.settings.ai.primaryModel);
  const aiPrimaryProvider = useSettingsStore((s) => s.settings.ai.primaryProvider);

  return useAgenticLoop({
    ...options,
    context,
    config: {
      ...options.config,
      contextRefresher,
      maxOutputTokens: options.config?.maxOutputTokens ?? aiMaxTokens,
      activeModel: options.config?.activeModel ?? aiPrimaryModel,
      activeProvider: options.config?.activeProvider ?? aiPrimaryProvider,
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
