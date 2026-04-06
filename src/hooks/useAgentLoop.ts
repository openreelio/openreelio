/**
 * useAgentLoop Hook
 *
 * React hook for the simplified AgentLoop compatibility runtime
 * (opencode-style stream -> tool -> loop).
 * This is the counterpart of useAgenticLoop for internal compatibility
 * verification when USE_AGENT_LOOP is enabled.
 *
 * Much simpler than the TPAO hook: iterates the AsyncGenerator, dispatches events
 * to the conversation store, handles abort and error recovery.
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import {
  createAgentLoop,
  type AgentLoop,
  type AgentLoopConfig,
  type AgentLoopEvent,
  type ToolCallResult,
  AgentLoopAbortedError,
} from '@/agents/engine/AgentLoop';
import type { ILLMClient } from '@/agents/engine/ports/ILLMClient';
import type { IToolExecutor } from '@/agents/engine/ports/IToolExecutor';
import type { AgentContext, RiskLevel } from '@/agents/engine/core/types';
import type { TokenUsage, ConversationMessage } from '@/agents/engine/core/conversation';
import { createEmptyContext, generateId } from '@/agents/engine/core/types';
import {
  buildCompactionTraceRecord,
  buildCompactionPayload,
} from '@/agents/engine/core/recoveryPersistence';
import { isAgentLoopEnabled } from '@/config/featureFlags';
import { useConversationStore } from '@/stores/conversationStore';
import { usePermissionStore } from '@/stores/permissionStore';
import { useAgentSessionStore } from '@/stores/agentSessionStore';
import {
  buildPermissionTraceRecord,
  persistPermissionAudit,
} from '@/agents/engine/core/permissionAudit';
import { TraceRecorder, type AgentTrace } from '@/agents/engine/core/traceRecorder';
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

const logger = createLogger('useAgentLoop');
const CONTEXT_HISTORY_LIMIT = 30;

// =============================================================================
// Types
// =============================================================================

/** Phase displayed in the UI during agent loop execution */
export type AgentLoopPhase =
  | 'idle'
  | 'streaming'
  | 'executing_tools'
  | 'completed'
  | 'failed'
  | 'aborted';

export interface UseAgentLoopOptions {
  llmClient: ILLMClient;
  toolExecutor: IToolExecutor;
  config?: Partial<AgentLoopConfig>;
  context?: Partial<AgentContext>;

  /** Called for each event from the loop */
  onEvent?: (event: AgentLoopEvent) => void;
  /** Called when the loop completes */
  onComplete?: (usage?: TokenUsage) => void;
  /** Called on error */
  onError?: (error: Error) => void;
  /** Called on abort */
  onAbort?: () => void;
}

export interface UseAgentLoopReturn {
  phase: AgentLoopPhase;
  isRunning: boolean;
  events: AgentLoopEvent[];
  error: Error | null;
  toolResults: ToolCallResult[];
  pendingToolPermissionRequest: {
    id: string;
    tool: string;
    args: Record<string, unknown>;
    description: string;
    riskLevel: RiskLevel;
  } | null;
  isEnabled: boolean;

  run: (input: string) => Promise<void>;
  abort: () => void;
  reset: () => void;
  retry: () => Promise<void>;
  /** Respond to a tool permission request */
  approveToolPermission: (decision: 'allow' | 'deny' | 'allow_always') => void;
}

// =============================================================================
// Hook Implementation
// =============================================================================

export function useAgentLoop(options: UseAgentLoopOptions): UseAgentLoopReturn {
  const { llmClient, toolExecutor, config, context: externalContext } = options;

  // State
  const [phase, setPhase] = useState<AgentLoopPhase>('idle');
  const [isRunning, setIsRunning] = useState(false);
  const [events, setEvents] = useState<AgentLoopEvent[]>([]);
  const [error, setError] = useState<Error | null>(null);
  const [toolResults, setToolResults] = useState<ToolCallResult[]>([]);
  const [pendingToolPermissionRequest, setPendingToolPermissionRequest] = useState<{
    id: string;
    tool: string;
    args: Record<string, unknown>;
    description: string;
    riskLevel: RiskLevel;
  } | null>(null);

  // Refs
  const loopRef = useRef<AgentLoop | null>(null);
  const runGuardRef = useRef(false);
  const abortNotifiedRef = useRef(false);
  const toolPermissionResolverRef = useRef<{
    resolve: (decision: 'allow' | 'deny' | 'allow_always') => void;
    tool: string;
    args: Record<string, unknown>;
  } | null>(null);
  const bootstrappedCheckpointIdRef = useRef<string | null>(null);
  const persistedRunIdRef = useRef<string | null>(null);
  const optionsRef = useRef(options);

  useEffect(() => {
    optionsRef.current = options;
  }, [options]);

  const emitSyntheticEvent = useCallback((event: AgentLoopEvent): void => {
    setEvents((prev) => [...prev, event]);
    optionsRef.current.onEvent?.(event);
  }, []);

  const isEnabled = typeof isAgentLoopEnabled === 'function' ? isAgentLoopEnabled() : false;

  // Build context
  const buildContext = useCallback((): AgentContext => {
    const projectId = externalContext?.projectId ?? 'unknown';
    const base = createEmptyContext(projectId);
    return { ...base, ...externalContext, projectId };
  }, [externalContext]);

  // Run the loop
  const run = useCallback(
    async (input: string): Promise<void> => {
      if (!isEnabled) {
        const disabledError = new Error(
          'Agent loop compatibility runtime is disabled via feature flag. Enable USE_AGENT_LOOP for internal compatibility verification.',
        );
        setError(disabledError);
        setPhase('failed');
        optionsRef.current.onError?.(disabledError);
        return;
      }

      if (runGuardRef.current) {
        logger.warn('Agent loop is already running');
        return;
      }
      runGuardRef.current = true;
      persistedRunIdRef.current = null;

      // Reset state
      setIsRunning(true);
      setEvents([]);
      setError(null);
      setToolResults([]);
      setPendingToolPermissionRequest(null);
      setPhase('streaming');
      abortNotifiedRef.current = false;

      // Pre-flight: check AI provider
      const providerConfigured = await ensureConfiguredProvider(llmClient, logger, 'agent loop');
      if (!providerConfigured) {
        const configError = new Error(
          'AI provider not configured. Go to Settings > AI to set up your API key.',
        );
        setError(configError);
        setPhase('failed');
        setIsRunning(false);
        optionsRef.current.onError?.(configError);
        runGuardRef.current = false;
        return;
      }

      const context = buildContext();
      const store = useConversationStore.getState();
      const contextProjectId =
        context.projectId && context.projectId !== 'current' && context.projectId !== 'unknown'
          ? context.projectId
          : null;
      const bootstrapProjectId = useProjectStore.getState().meta?.id ?? contextProjectId;
      if (!store.activeProjectId && bootstrapProjectId) {
        store.loadForProject(bootstrapProjectId);
      }

      const storeSessionId = await ensureConversationSessionId(useConversationStore.getState());
      if (!storeSessionId) {
        const sessionError = new Error(
          'Conversation session is required before starting agent loop',
        );
        setError(sessionError);
        setPhase('failed');
        setIsRunning(false);
        optionsRef.current.onError?.(sessionError);
        runGuardRef.current = false;
        return;
      }

      const projectId = store.activeProjectId ?? context.projectId;
      const agentSessionStore = useAgentSessionStore.getState();
      const persistedTraceId = config?.enableTracing === false ? null : generateId('trace');
      const runtimeTraceRecorder = persistedTraceId ? new TraceRecorder() : null;
      runtimeTraceRecorder?.startRun({
        sessionId: storeSessionId,
        input,
        model: config?.activeModel,
        provider: config?.activeProvider,
        traceId: persistedTraceId ?? undefined,
        runtimeKind: 'fast',
      });
      const checkpointController = createResumeCheckpointController({
        sessionId: storeSessionId,
        persistedRunIdRef,
        logger,
        loggerLabel: 'fast-loop',
        onCheckpointPersisted: (record) => runtimeTraceRecorder?.recordCheckpointEvent(record),
        onCheckpointConsumed: (record) => runtimeTraceRecorder?.recordCheckpointEvent(record),
      });
      const persistCompactionBoundary = async (
        event: Extract<AgentLoopEvent, { type: 'compacted' }>,
      ): Promise<void> => {
        const compactionPayload = buildCompactionPayload({
          sessionId: storeSessionId,
          runId: persistedRunIdRef.current,
          runtimeKind: 'fast',
          trigger: 'auto',
          projectId: context.projectId,
          sequenceId: context.sequenceId ?? null,
          input,
          summary: event.summary,
          sourceMessageCount: event.originalMessageCount,
          retainedMessageCount: event.retainedMessageCount,
          estimatedTokensSaved: event.estimatedTokensSaved,
        });

        let didPersistCompaction = false;
        try {
          const compaction = await agentSessionStore.recordCompaction({
            sessionId: storeSessionId,
            runId: persistedRunIdRef.current,
            tier: 'summary',
            trigger: 'auto',
            sourceMessageCount: event.originalMessageCount,
            retainedMessageCount: event.retainedMessageCount,
            estimatedTokensSaved: event.estimatedTokensSaved,
            continuationSummaryJson: compactionPayload.continuationSummaryJson,
            stateRehydrationJson: compactionPayload.stateRehydrationJson,
          });
          runtimeTraceRecorder?.recordCompactionEvent(
            buildCompactionTraceRecord({
              compactionId: compaction.id,
              runId: persistedRunIdRef.current,
              tier: 'summary',
              trigger: 'auto',
              summary: event.summary,
              sourceMessageCount: event.originalMessageCount,
              retainedMessageCount: event.retainedMessageCount,
              estimatedTokensSaved: event.estimatedTokensSaved,
              status: 'persisted',
              recordedAt: compaction.createdAt,
            }),
          );
          didPersistCompaction = true;
        } catch (error) {
          logger.warn('Failed to persist fast-loop compaction record', {
            sessionId: storeSessionId,
            error: error instanceof Error ? error.message : String(error),
          });
        }

        if (!didPersistCompaction) {
          return;
        }

        await checkpointController.persistCheckpoint({
          sessionId: storeSessionId,
          runId: persistedRunIdRef.current,
          runtimeKind: 'fast',
          checkpointKind: 'compaction_boundary',
          phase: 'compacting',
          projectId: context.projectId,
          sequenceId: context.sequenceId ?? null,
          input,
          summary: event.summary,
          sourceMessageCount: event.originalMessageCount,
          retainedMessageCount: event.retainedMessageCount,
          estimatedTokensSaved: event.estimatedTokensSaved,
        });
      };
      await bootstrapPersistedAgentSession({
        sessionId: storeSessionId,
        projectId,
        sequenceId: context.sequenceId ?? null,
        runtimeKind: 'fast',
        modelProvider: config?.activeProvider ?? null,
        modelId: config?.activeModel ?? null,
        logger,
        loggerLabel: 'agent loop',
      });
      await bootstrapRecoveredContextFromCheckpoint({
        sessionId: storeSessionId,
        addSystemMessage: store.addSystemMessage,
        logger,
        loggerLabel: 'agent loop',
        lastBootstrappedCheckpointIdRef: bootstrappedCheckpointIdRef,
        onCheckpointRecovered: (record) => runtimeTraceRecorder?.recordCheckpointEvent(record),
        onCompactionRecovered: (record) => runtimeTraceRecorder?.recordCompactionEvent(record),
      });

      let persistedToolCalls = 0;
      let persistedFinalPhase: 'completed' | 'failed' | 'aborted' = 'completed';
      let persistedErrorMessage: string | null = null;
      let traceToWrite: AgentTrace | null = null;
      let finalizedRuntimeTrace: AgentTrace | null = null;
      let traceIterations = 1;
      let currentTracePhase: 'planning' | 'executing' = 'planning';

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
        sessionId: storeSessionId,
        runtimeKind: 'fast',
        maxIterations: config?.maxIterations,
        traceId: persistedTraceId,
        runInput: input,
        context,
        checkpointController,
        persistedRunIdRef,
        logger,
        loggerLabel: 'agent loop',
      });
      runtimeTraceRecorder?.setArtifactState({
        persistedRunId: startedRunId,
      });
      runtimeTraceRecorder?.startPhase('planning');
      runtimeTraceRecorder?.setIterations(traceIterations);

      // Create the loop
      const baseToolPermissionHandler =
        config?.toolPermissionHandler ??
        (async (toolName, args, riskLevel) => {
          void riskLevel;
          const resolution = usePermissionStore.getState().resolvePermissionDetails(toolName, args);

          if (resolution.permission === 'allow' || resolution.permission === 'deny') {
            runtimeTraceRecorder?.recordPermissionEvent(
              buildPermissionTraceRecord({
                runId: persistedRunIdRef.current,
                stepId: null,
                resolution,
                action: resolution.permission,
              }),
            );
            persistPermissionAudit(
              storeSessionId,
              persistedRunIdRef.current,
              null,
              resolution,
              resolution.permission,
            );
            return resolution.permission;
          }

          runtimeTraceRecorder?.recordPermissionEvent(
            buildPermissionTraceRecord({
              runId: persistedRunIdRef.current,
              stepId: null,
              resolution,
              action: 'ask',
            }),
          );
          persistPermissionAudit(
            storeSessionId,
            persistedRunIdRef.current,
            null,
            resolution,
            'ask',
          );

          const decision = await new Promise<'allow' | 'deny' | 'allow_always'>((resolve) => {
            toolPermissionResolverRef.current = { resolve, tool: toolName, args };
          });

          runtimeTraceRecorder?.recordPermissionEvent(
            buildPermissionTraceRecord({
              runId: persistedRunIdRef.current,
              stepId: null,
              resolution,
              action: decision,
              source: 'interactive_approval',
            }),
          );
          persistPermissionAudit(
            storeSessionId,
            persistedRunIdRef.current,
            null,
            resolution,
            decision,
            'interactive_approval',
          );

          return decision;
        });

      const loop = createAgentLoop(llmClient, toolExecutor, {
        ...config,
        toolPermissionHandler: async (toolName, args, riskLevel) => {
          const decisionPromise = baseToolPermissionHandler(toolName, args, riskLevel);
          let autoResolved = false;
          let autoDecision: 'allow' | 'deny' | 'allow_always' | undefined;
          let permissionRequestId: string | null = null;

          void decisionPromise.then((decision) => {
            if (!autoResolved) {
              autoResolved = true;
              autoDecision = decision;
            }
          });

          await Promise.resolve();

          let checkpointId: string | null = null;
          if (!autoResolved) {
            permissionRequestId = `tool-permission-${toolName}-${Date.now()}`;
            setPendingToolPermissionRequest({
              id: permissionRequestId,
              tool: toolName,
              args,
              description: `Permission required for ${toolName}`,
              riskLevel,
            });
            emitSyntheticEvent({
              type: 'tool_permission_request',
              id: permissionRequestId,
              tool: toolName,
              args,
              riskLevel,
            });
            checkpointId = await checkpointController.persistCheckpoint({
              sessionId: storeSessionId,
              runId: persistedRunIdRef.current,
              runtimeKind: 'fast',
              checkpointKind: 'tool_wait',
              phase: 'awaiting_tool_permission',
              projectId: context.projectId,
              sequenceId: context.sequenceId ?? null,
              input,
              toolName,
              args,
            });
            autoResolved = true;
          }

          try {
            const decision = autoDecision ?? (await decisionPromise);
            if (permissionRequestId) {
              setPendingToolPermissionRequest(null);
              emitSyntheticEvent({
                type: 'tool_permission_response',
                id: permissionRequestId,
                tool: toolName,
                decision,
              });
            }
            return decision;
          } finally {
            await checkpointController.consumeCheckpoint(checkpointId);
          }
        },
      });
      loopRef.current = loop;

      // Get conversation history
      const rawHistory: ConversationMessage[] = store.activeConversation?.messages ?? [];
      const historySlice = rawHistory.slice(-CONTEXT_HISTORY_LIMIT);

      try {
        const gen = loop.run(storeSessionId, input, context, historySlice);

        for await (const event of gen) {
          // Dispatch to state
          setEvents((prev) => [...prev, event]);

          switch (event.type) {
            case 'tool_call_start':
              if (currentTracePhase !== 'executing') {
                runtimeTraceRecorder?.startPhase('executing');
                currentTracePhase = 'executing';
              }
              setPhase('executing_tools');
              break;

            case 'tool_call_complete':
              runtimeTraceRecorder?.recordToolCall({
                name: event.name,
                success: event.result.success,
                durationMs: event.result.duration,
                error: event.result.error,
              });
              persistedToolCalls += 1;
              setToolResults((prev) => [...prev, event.result]);
              break;

            case 'compacted':
              await persistCompactionBoundary(event);
              break;

            case 'tools_executed':
              traceIterations += 1;
              runtimeTraceRecorder?.setIterations(traceIterations);
              if (currentTracePhase !== 'planning') {
                runtimeTraceRecorder?.startPhase('planning');
                currentTracePhase = 'planning';
              }
              setPhase('streaming'); // Back to streaming for next iteration
              break;

            case 'error':
              persistedFinalPhase = 'failed';
              persistedErrorMessage = event.error.message;
              setError(event.error);
              setPhase('failed');
              setPendingToolPermissionRequest(null);
              optionsRef.current.onError?.(event.error);
              break;

            case 'done':
              runtimeTraceRecorder?.setFastPath(event.fastPath ?? false);
              runtimeTraceRecorder?.addTokenUsage({
                inputTokens: event.usage?.promptTokens ?? 0,
                outputTokens: event.usage?.completionTokens ?? 0,
              });
              if (persistedFinalPhase !== 'failed') {
                persistedFinalPhase = 'completed';
              }
              traceToWrite = finalizeRuntimeTrace(
                persistedFinalPhase === 'completed',
                persistedErrorMessage,
              );
              // Only mark completed if no prior error/doom-loop occurred
              setPhase((prev) => (prev === 'failed' ? 'failed' : 'completed'));
              setPendingToolPermissionRequest(null);
              optionsRef.current.onComplete?.(event.usage);
              break;

            case 'doom_loop_detected': {
              persistedFinalPhase = 'failed';
              const doomErr = new Error(
                `Doom loop detected: ${event.tool} called ${event.count} times`,
              );
              persistedErrorMessage = doomErr.message;
              traceToWrite = finalizeRuntimeTrace(false, doomErr.message);
              setError(doomErr);
              setPhase('failed');
              setPendingToolPermissionRequest(null);
              optionsRef.current.onError?.(doomErr);
              break;
            }
          }

          // Forward to external handler
          optionsRef.current.onEvent?.(event);
        }
      } catch (err) {
        if (err instanceof AgentLoopAbortedError) {
          persistedFinalPhase = 'aborted';
          traceToWrite = finalizeRuntimeTrace(false, 'Aborted by user');
          setPhase('aborted');
          setPendingToolPermissionRequest(null);
          if (!abortNotifiedRef.current) {
            abortNotifiedRef.current = true;
            optionsRef.current.onAbort?.();
          }
        } else {
          const loopError = err instanceof Error ? err : new Error(String(err));
          persistedFinalPhase = 'failed';
          persistedErrorMessage = loopError.message;
          traceToWrite = finalizeRuntimeTrace(false, loopError.message);
          setError(loopError);
          setPhase('failed');
          setPendingToolPermissionRequest(null);
          optionsRef.current.onError?.(loopError);
        }
      } finally {
        const persistedRunId = persistedRunIdRef.current;
        persistedRunIdRef.current = null;
        if (persistedRunId) {
          await finalizePersistedRun({
            sessionId: storeSessionId,
            runId: persistedRunId,
            phase: persistedFinalPhase,
            traceId: persistedTraceId,
            toolCallsUsed: persistedToolCalls,
            errorMessage: persistedErrorMessage,
            reportIssue: (input) => {
              agentSessionStore.reportPersistenceIssue({
                sessionId: input.sessionId,
                stage: input.stage,
                error: input.error,
              });
            },
            logger,
            loggerLabel: 'agent loop',
          });
        }
        if (!traceToWrite) {
          traceToWrite = finalizeRuntimeTrace(
            persistedFinalPhase === 'completed',
            persistedErrorMessage,
          );
        }
        if (traceToWrite) {
          traceToWrite = {
            ...traceToWrite,
            artifacts: {
              ...traceToWrite.artifacts,
              ...getPersistedSessionTraceState(storeSessionId),
              persistedRunId: persistedRunId ?? traceToWrite.artifacts.persistedRunId,
            },
          };
          await writeTrace(traceToWrite);
        }

        runGuardRef.current = false;
        setIsRunning(false);
        loopRef.current = null;
      }
    },
    [isEnabled, llmClient, toolExecutor, config, buildContext, emitSyntheticEvent],
  );

  // Abort
  const abort = useCallback(() => {
    loopRef.current?.abort();
    // Unblock pending permission
    toolPermissionResolverRef.current?.resolve('deny');
    toolPermissionResolverRef.current = null;
    setPendingToolPermissionRequest(null);
    setPhase('aborted');
    if (!abortNotifiedRef.current) {
      abortNotifiedRef.current = true;
      optionsRef.current.onAbort?.();
    }
  }, []);

  // Reset
  const reset = useCallback(() => {
    runGuardRef.current = false;
    loopRef.current = null;
    toolPermissionResolverRef.current = null;
    bootstrappedCheckpointIdRef.current = null;
    abortNotifiedRef.current = false;
    setPhase('idle');
    setIsRunning(false);
    setEvents([]);
    setError(null);
    setToolResults([]);
    setPendingToolPermissionRequest(null);
  }, []);

  // Tool permission
  const approveToolPermission = useCallback((decision: 'allow' | 'deny' | 'allow_always') => {
    if (decision === 'allow_always' && toolPermissionResolverRef.current?.tool) {
      usePermissionStore
        .getState()
        .allowAlways(
          toolPermissionResolverRef.current.tool,
          toolPermissionResolverRef.current.args,
        );
    }
    toolPermissionResolverRef.current?.resolve(decision);
    toolPermissionResolverRef.current = null;
  }, []);

  // Retry
  const retry = useCallback(async () => {
    const lastInput = useConversationStore.getState().getLastUserInput();
    if (!lastInput) {
      logger.warn('No previous input to retry');
      return;
    }
    return run(lastInput);
  }, [run]);

  // Cleanup on unmount: abort loop AND resolve pending permission prompts
  useEffect(() => {
    return () => {
      loopRef.current?.abort();
      // Unblock any pending tool-permission promise so the loop doesn't hang
      toolPermissionResolverRef.current?.resolve('deny');
      toolPermissionResolverRef.current = null;
    };
  }, []);

  return {
    phase,
    isRunning,
    events,
    error,
    toolResults,
    pendingToolPermissionRequest,
    isEnabled,
    run,
    abort,
    reset,
    retry,
    approveToolPermission,
  };
}

// =============================================================================
// Extended Hook: useAgentLoopWithStores
// =============================================================================

/**
 * Extended hook that integrates with Zustand stores to build context automatically.
 */
export function useAgentLoopWithStores(
  options: Omit<UseAgentLoopOptions, 'context'> & { context?: Partial<AgentContext> },
): UseAgentLoopReturn {
  const { context, contextRefresher, aiMaxTokens, aiPrimaryModel, aiPrimaryProvider } =
    useAgentRuntimeStoreContext(options.context);

  return useAgentLoop({
    ...options,
    context,
    config: {
      ...options.config,
      contextRefresher,
      activeModel: options.config?.activeModel ?? aiPrimaryModel ?? undefined,
      activeProvider: options.config?.activeProvider ?? aiPrimaryProvider ?? undefined,
      generateOptions: {
        ...options.config?.generateOptions,
        maxTokens: options.config?.generateOptions?.maxTokens ?? aiMaxTokens,
      },
    },
  });
}
