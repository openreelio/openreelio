/**
 * useAgentLoop Hook
 *
 * React hook for the simplified AgentLoop (opencode-style stream -> tool -> loop).
 * This is the counterpart of useAgenticLoop for the new USE_AGENT_LOOP feature flag.
 *
 * Much simpler than the TPAO hook: iterates the AsyncGenerator, dispatches events
 * to the conversation store, handles abort and error recovery.
 */

import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
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
import type { AgentContext } from '@/agents/engine/core/types';
import type { TokenUsage, ConversationMessage } from '@/agents/engine/core/conversation';
import { createEmptyContext, createLanguagePolicy } from '@/agents/engine/core/types';
import { isAgentLoopEnabled } from '@/config/featureFlags';
import { useConversationStore } from '@/stores/conversationStore';
import { usePermissionStore } from '@/stores/permissionStore';
import { usePlaybackStore } from '@/stores/playbackStore';
import { useTimelineStore } from '@/stores/timelineStore';
import { useProjectStore } from '@/stores';
import { useSettingsStore } from '@/stores/settingsStore';
import { globalToolRegistry } from '@/agents';
import { createLogger } from '@/services/logger';

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

  // Refs
  const loopRef = useRef<AgentLoop | null>(null);
  const runGuardRef = useRef(false);
  const toolPermissionResolverRef = useRef<{
    resolve: (decision: 'allow' | 'deny' | 'allow_always') => void;
    tool: string;
  } | null>(null);
  const optionsRef = useRef(options);

  useEffect(() => {
    optionsRef.current = options;
  }, [options]);

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
          'Agent loop is disabled via feature flag. Enable USE_AGENT_LOOP to use.',
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

      // Reset state
      setIsRunning(true);
      setEvents([]);
      setError(null);
      setToolResults([]);
      setPhase('streaming');

      // Pre-flight: check AI provider
      if (typeof llmClient.isConfigured === 'function' && !llmClient.isConfigured()) {
        const refreshable = llmClient as ILLMClient & {
          refreshStatus?: () => Promise<{ isConfigured: boolean }>;
        };
        if (typeof refreshable.refreshStatus === 'function') {
          try {
            await refreshable.refreshStatus();
          } catch {
            // Ignore refresh failure
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
        runGuardRef.current = false;
        return;
      }

      const context = buildContext();

      // Create the loop
      const loop = createAgentLoop(llmClient, toolExecutor, {
        ...config,
        toolPermissionHandler:
          config?.toolPermissionHandler ??
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          (async (toolName, _args, _riskLevel) => {
            const permission = usePermissionStore.getState().resolvePermission(toolName);
            if (permission === 'allow') return 'allow';
            if (permission === 'deny') return 'deny';
            // 'ask' — wait for user
            return new Promise<'allow' | 'deny' | 'allow_always'>((resolve) => {
              toolPermissionResolverRef.current = { resolve, tool: toolName };
            });
          }),
      });
      loopRef.current = loop;

      // Get conversation history
      const store = useConversationStore.getState();
      const rawHistory: ConversationMessage[] = store.activeConversation?.messages ?? [];
      const historySlice = rawHistory.slice(-CONTEXT_HISTORY_LIMIT);

      try {
        const gen = loop.run(
          store.activeSessionId ?? crypto.randomUUID(),
          input,
          context,
          historySlice,
        );

        for await (const event of gen) {
          // Dispatch to state
          setEvents((prev) => [...prev, event]);

          switch (event.type) {
            case 'tool_call_start':
              setPhase('executing_tools');
              break;

            case 'tool_call_complete':
              setToolResults((prev) => [...prev, event.result]);
              break;

            case 'tools_executed':
              setPhase('streaming'); // Back to streaming for next iteration
              break;

            case 'error':
              setError(event.error);
              setPhase('failed');
              optionsRef.current.onError?.(event.error);
              break;

            case 'done':
              // Only mark completed if no prior error/doom-loop occurred
              setPhase((prev) => (prev === 'failed' ? 'failed' : 'completed'));
              optionsRef.current.onComplete?.(event.usage);
              break;

            case 'doom_loop_detected': {
              const doomErr = new Error(
                `Doom loop detected: ${event.tool} called ${event.count} times`,
              );
              setError(doomErr);
              setPhase('failed');
              optionsRef.current.onError?.(doomErr);
              break;
            }
          }

          // Forward to external handler
          optionsRef.current.onEvent?.(event);
        }
      } catch (err) {
        if (err instanceof AgentLoopAbortedError) {
          setPhase('aborted');
          optionsRef.current.onAbort?.();
        } else {
          const loopError = err instanceof Error ? err : new Error(String(err));
          setError(loopError);
          setPhase('failed');
          optionsRef.current.onError?.(loopError);
        }
      } finally {
        runGuardRef.current = false;
        setIsRunning(false);
        loopRef.current = null;
      }
    },
    [isEnabled, llmClient, toolExecutor, config, buildContext],
  );

  // Abort
  const abort = useCallback(() => {
    loopRef.current?.abort();
    // Unblock pending permission
    toolPermissionResolverRef.current?.resolve('deny');
    toolPermissionResolverRef.current = null;
    setPhase('aborted');
    setIsRunning(false);
    optionsRef.current.onAbort?.();
  }, []);

  // Reset
  const reset = useCallback(() => {
    runGuardRef.current = false;
    loopRef.current = null;
    toolPermissionResolverRef.current = null;
    setPhase('idle');
    setIsRunning(false);
    setEvents([]);
    setError(null);
    setToolResults([]);
  }, []);

  // Tool permission
  const approveToolPermission = useCallback(
    (decision: 'allow' | 'deny' | 'allow_always') => {
      if (decision === 'allow_always' && toolPermissionResolverRef.current?.tool) {
        usePermissionStore.getState().allowAlways(toolPermissionResolverRef.current.tool);
      }
      toolPermissionResolverRef.current?.resolve(decision);
      toolPermissionResolverRef.current = null;
    },
    [],
  );

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
    isEnabled,
    run,
    abort,
    reset,
    retry,
    approveToolPermission,
  };
}

// =============================================================================
// Shared Context Builder
// =============================================================================

interface StoreSnapshots {
  currentTime: number;
  duration: number;
  selectedClipIds: string[];
  selectedTrackIds: string[];
  activeSequenceId: string | null;
  projectStateVersion: number;
  sequences: Map<string, { tracks: Array<{ id: string; name: string; kind: string; clips: Array<{ id: string; assetId: string; label?: string; place: { timelineInSec: number } }> }> }>;
  assets: Map<string, { id: string; name: string; kind: string; durationSec?: number }>;
  uiLanguage: string;
}

/**
 * Builds an AgentContext from store snapshots. Shared between
 * the reactive useMemo path and the imperative contextRefresher.
 */
function buildContextFromStores(
  stores: StoreSnapshots,
  externalContext?: Partial<AgentContext>,
): Partial<AgentContext> {
  const activeSequence = stores.activeSequenceId
    ? stores.sequences.get(stores.activeSequenceId)
    : undefined;

  const storeContext: Partial<AgentContext> = {
    projectId: 'current',
    sequenceId: stores.activeSequenceId ?? undefined,
    languagePolicy: createLanguagePolicy(stores.uiLanguage),
    projectStateVersion: stores.projectStateVersion,
    playheadPosition: stores.currentTime,
    timelineDuration: stores.duration,
    selectedClips: stores.selectedClipIds,
    selectedTracks: stores.selectedTrackIds,
    availableAssets: Array.from(stores.assets.values())
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
  const externalContext = options.context;

  const currentTime = usePlaybackStore((s) => s.currentTime);
  const duration = usePlaybackStore((s) => s.duration);
  const selectedClipIds = useTimelineStore((s) => s.selectedClipIds);
  const selectedTrackIds = useTimelineStore((s) => s.selectedTrackIds);
  const activeSequenceId = useProjectStore((s) => s.activeSequenceId);
  const projectStateVersion = useProjectStore((s) => s.stateVersion);
  const sequences = useProjectStore((s) => s.sequences);
  const assets = useProjectStore((s) => s.assets);
  const uiLanguage = useSettingsStore((s) => s.settings.general.language);

  const context = useMemo(
    () =>
      buildContextFromStores(
        {
          currentTime,
          duration,
          selectedClipIds,
          selectedTrackIds,
          activeSequenceId,
          projectStateVersion,
          sequences,
          assets,
          uiLanguage,
        },
        externalContext,
      ),
    [
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
    ],
  );

  const contextRefresher = useCallback((): Partial<AgentContext> => {
    const playback = usePlaybackStore.getState();
    const timeline = useTimelineStore.getState();
    const project = useProjectStore.getState();
    const settings = useSettingsStore.getState();

    return buildContextFromStores(
      {
        currentTime: playback.currentTime,
        duration: playback.duration,
        selectedClipIds: timeline.selectedClipIds,
        selectedTrackIds: timeline.selectedTrackIds,
        activeSequenceId: project.activeSequenceId,
        projectStateVersion: project.stateVersion,
        sequences: project.sequences,
        assets: project.assets,
        uiLanguage: settings.settings.general.language,
      },
      externalContext,
    );
  }, [externalContext]);

  return useAgentLoop({
    ...options,
    context,
    config: {
      ...options.config,
      contextRefresher,
    },
  });
}
