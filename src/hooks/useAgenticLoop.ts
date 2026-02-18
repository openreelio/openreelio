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
import { useSettingsStore } from '@/stores/settingsStore';
import { globalToolRegistry } from '@/agents';
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
  const approvalResolverRef = useRef<{
    resolve: (result: { approved: boolean; feedback?: string }) => void;
  } | null>(null);
  const toolPermissionResolverRef = useRef<{
    resolve: (decision: 'allow' | 'deny' | 'allow_always') => void;
    step: unknown;
  } | null>(null);
  const memoryStoreRef = useRef<IMemoryStore | null>(null);

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
        logger.warn('Agentic engine is disabled via feature flag');
        return null;
      }

      if (isRunning) {
        logger.warn('Engine is already running');
        return null;
      }

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
        return null;
      }

      // Build context
      const context = buildContext();

      // Create execution context
      const executionContext = {
        projectId: context.projectId,
        sequenceId: context.sequenceId,
        sessionId: crypto.randomUUID(),
        expectedStateVersion: context.projectStateVersion,
      };

      try {
        // Create engine
        const engine = createAgenticEngine(llmClient, toolExecutor, {
          ...config,
          memoryStore: config?.memoryStore ?? memoryStoreRef.current ?? undefined,
          approvalHandler:
            config?.approvalHandler ??
            (async () => {
              return await new Promise<{ approved: boolean; feedback?: string }>(
                (resolve) => {
                  approvalResolverRef.current = { resolve };
                },
              );
            }),
          toolPermissionHandler:
            config?.toolPermissionHandler ??
            (async (toolName, _args, step) => {
              const permission =
                usePermissionStore.getState().resolvePermission(toolName);
              if (permission === 'allow') return 'allow';
              if (permission === 'deny') return 'deny';
              // 'ask' — show inline approval UI, wait for user response
              return await new Promise<'allow' | 'deny' | 'allow_always'>(
                (resolve) => {
                  toolPermissionResolverRef.current = {
                    resolve,
                    step,
                  };
                },
              );
            }),
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
          setPhase(result.finalState.phase);
          optionsRef.current.onComplete?.(result);
        }

        return result;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        setError(error);
        setPhase('failed');
        optionsRef.current.onError?.(error);
        logger.error('Engine run failed', { error: error.message });
        throw error;
      } finally {
        setIsRunning(false);
        engineRef.current = null;
      }
    },
    [isEnabled, isRunning, llmClient, toolExecutor, config, buildContext, handleEvent],
  );

  // Abort
  const abort = useCallback(() => {
    abortedRef.current = true;
    engineRef.current?.abort();
    // Unblock pending promises so the engine can finish aborting
    approvalResolverRef.current?.resolve({ approved: true });
    approvalResolverRef.current = null;
    toolPermissionResolverRef.current?.resolve('allow');
    toolPermissionResolverRef.current = null;
    setPhase('aborted');
    setIsRunning(false);
    optionsRef.current.onAbort?.();
    logger.info('Engine aborted by user');
  }, []);

  // Reset
  const reset = useCallback(() => {
    abortedRef.current = false;
    engineRef.current = null;
    approvalResolverRef.current = null;
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
  const approveToolPermission = useCallback(
    (decision: 'allow' | 'deny' | 'allow_always') => {
      if (decision === 'allow_always' && toolPermissionResolverRef.current?.step) {
        const step = toolPermissionResolverRef.current.step as { tool?: string };
        if (step.tool) {
          usePermissionStore.getState().allowAlways(step.tool);
        }
      }
      toolPermissionResolverRef.current?.resolve(decision);
      toolPermissionResolverRef.current = null;
    },
    [],
  );

  // Retry with last user input
  const retry = useCallback(async (): Promise<AgentRunResult | null> => {
    const lastInput = useConversationStore.getState().getLastUserInput();
    if (!lastInput) {
      logger.warn('No previous input to retry');
      return null;
    }
    return run(lastInput);
  }, [run]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (engineRef.current) {
        engineRef.current.abort();
      }
    };
  }, []);

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

  return useAgenticLoop({
    ...options,
    context,
    config: {
      ...options.config,
      contextRefresher,
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
