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
  type AgentEvent,
  type AgentRunResult,
  type AgenticEngineConfig,
  type ILLMClient,
  type IToolExecutor,
  type AgentPhase,
  type AgentContext,
  type LLMMessage,
  type Thought,
  type Plan,
} from '@/agents/engine';
import { isAgenticEngineEnabled } from '@/config/featureFlags';
import { useConversationStore } from '@/stores/conversationStore';
import { usePlaybackStore } from '@/stores/playbackStore';
import { useTimelineStore } from '@/stores/timelineStore';
import { useProjectStore } from '@/stores';
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
  /** Reject pending plan */
  rejectPlan: (reason?: string) => void;
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
  const {
    llmClient,
    toolExecutor,
    config,
    context: externalContext,
  } = options;

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
    resolve: (approved: boolean) => void;
  } | null>(null);

  // Options ref to avoid stale closures
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  }, [options]);

  // Check if feature is enabled (with fallback for test environments)
  const isEnabled = typeof isAgenticEngineEnabled === 'function'
    ? isAgenticEngineEnabled()
    : false;

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
  const run = useCallback(async (input: string): Promise<AgentRunResult | null> => {
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

    // Build context
    const context = buildContext();

    // Create execution context
    const executionContext = {
      projectId: context.projectId,
      sequenceId: context.sequenceId,
      sessionId: crypto.randomUUID(),
    };

    try {
      // Create engine
      const engine = createAgenticEngine(llmClient, toolExecutor, {
        ...config,
        approvalHandler:
          config?.approvalHandler ??
          (async () => {
            return await new Promise<boolean>((resolve) => {
              approvalResolverRef.current = { resolve };
            });
          }),
      });
      engineRef.current = engine;

      // Get conversation history for multi-turn context
      const rawHistory = useConversationStore
        .getState()
        .getMessagesForContext(CONTEXT_HISTORY_LIMIT);
      const conversationHistory = trimDuplicatedTailUserMessageForContext(rawHistory, input);

      // Run engine with conversation history
      const result = await engine.run(input, context, executionContext, handleEvent, conversationHistory);

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
  }, [isEnabled, isRunning, llmClient, toolExecutor, config, buildContext, handleEvent]);

  // Abort
  const abort = useCallback(() => {
    abortedRef.current = true;
    engineRef.current?.abort();
    // If awaiting approval, unblock the approval promise so the engine can finish aborting.
    approvalResolverRef.current?.resolve(true);
    approvalResolverRef.current = null;
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
    approvalResolverRef.current?.resolve(true);
    approvalResolverRef.current = null;
  }, []);

  const rejectPlan = useCallback((_reason?: string) => {
    void _reason; // Reserved for future use (e.g., logging rejection reason)
    approvalResolverRef.current?.resolve(false);
    approvalResolverRef.current = null;
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
  options: Omit<UseAgenticLoopOptions, 'context'> & { context?: Partial<AgentContext> }
): UseAgenticLoopReturn {
  const externalContext = options.context;
  // Read from stores
  const currentTime = usePlaybackStore((s) => s.currentTime);
  const duration = usePlaybackStore((s) => s.duration);
  const selectedClipIds = useTimelineStore((s) => s.selectedClipIds);
  const selectedTrackIds = useTimelineStore((s) => s.selectedTrackIds);
  const activeSequenceId = useProjectStore((s) => s.activeSequenceId);
  const sequences = useProjectStore((s) => s.sequences);
  const assets = useProjectStore((s) => s.assets);

  // Build real context from stores
  const context = useMemo((): Partial<AgentContext> => {
    const activeSequence = activeSequenceId ? sequences.get(activeSequenceId) : undefined;

    const storeContext: Partial<AgentContext> = {
      projectId: 'current',
      sequenceId: activeSequenceId ?? undefined,
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
      availableTracks: activeSequence?.tracks.map((t) => ({
        id: t.id,
        name: t.name || `Track ${t.id}`,
        type: t.kind === 'audio' ? 'audio' as const : 'video' as const,
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
    sequences,
    assets,
    externalContext,
  ]);

  return useAgenticLoop({
    ...options,
    context,
  });
}

export function trimDuplicatedTailUserMessageForContext(
  history: LLMMessage[],
  input: string
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
