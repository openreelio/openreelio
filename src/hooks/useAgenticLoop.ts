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
  type ILLMClient,
  type IToolExecutor,
  type AgentPhase,
  type AgentContext,
  type Thought,
  type Plan,
} from '@/agents/engine';
import { isAgenticEngineEnabled } from '@/config/featureFlags';
import { createLogger } from '@/services/logger';

const logger = createLogger('useAgenticLoop');

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

      // Run engine
      const result = await engine.run(input, context, executionContext, handleEvent);

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
    approvalResolverRef.current?.resolve(false);
    approvalResolverRef.current = null;
  }, []);

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

    // Feature flag
    isEnabled,
  };
}

// =============================================================================
// Helper Hook: useAgenticLoopWithStores
// =============================================================================

/**
 * Extended hook that integrates with global stores.
 * Use this when you want automatic context from stores.
 */
export function useAgenticLoopWithStores(
  options: Omit<UseAgenticLoopOptions, 'context'>
): UseAgenticLoopReturn {
  // This would integrate with stores like useProjectStore, useTimelineStore, etc.
  // For now, just pass through to the base hook
  return useAgenticLoop(options);
}
