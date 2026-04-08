/**
 * AgenticSidebarContent Component
 *
 * Content for the AI sidebar.
 * Renders the canonical TPAO runtime for the shipping AI sidebar.
 */

import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { AgenticChat } from './AgenticChat';
import type { AgentRuntimeChatHandle } from './AgentRuntimeChatShell';
import { SessionList } from './SessionList';
import { AgentDelegationStrip } from './AgentDelegationStrip';
import { DEFAULT_AGENT_PROFILE_ID, type AgentRunResult } from '@/agents/engine';
import type { DelegationRecord } from '@/agents/engine/core/agentSession';
import type { ConversationMessage } from '@/agents/engine/core/conversation';
import { createTauriLLMAdapter } from '@/agents/engine/adapters/llm/TauriLLMAdapter';
import { createToolRegistryAdapter } from '@/agents/engine/adapters/tools/ToolRegistryAdapter';
import { createBackendToolExecutor } from '@/agents/engine/adapters/tools/BackendToolExecutor';
import {
  getAgentDisplayName,
  getAgentPromptPlaceholder,
  resolveAgentDefinition,
} from '@/agents/engine/core/agentCatalog';
import { listExperimentalSubAgentDefinitions } from '@/agents/engine/core/agentDefinitions.experimental';
import { globalToolRegistry } from '@/agents';
import {
  loadProjectPromptContext,
  type ProjectPromptContext,
} from '@/agents/engine/core/projectPromptContext';
import { useFeatureFlag, useSidebarRuntimePolicy } from '@/config/featureFlags';
import { useConversationStore, useProjectStore } from '@/stores';
import { useAgentArtifactReviewStore } from '@/stores/agentArtifactReviewStore';
import { useAgentSessionStore } from '@/stores/agentSessionStore';
import { useAgentDelegationStore } from '@/stores/agentDelegationStore';
import { useMessageQueueStore } from '@/stores/messageQueueStore';
import {
  findPanelZone,
  useWorkspaceLayoutStore,
  type DockZoneId,
  type PanelId,
} from '@/stores/workspaceLayoutStore';
import { createLogger } from '@/services/logger';
import {
  buildDelegationResultPayload,
  parseDelegationResultPayload,
  resolveDelegationReviewFocus,
  resolveDelegationSummaryMessageId,
} from './agentDelegationResult';

const logger = createLogger('AgenticSidebarContent');
const EMPTY_DELEGATIONS: readonly DelegationRecord[] = [];
const EMPTY_MESSAGES: readonly ConversationMessage[] = [];
const AGENT_REVIEW_PANEL_ID: PanelId = 'agent-review';
const DEFAULT_AGENT_REVIEW_ZONE: DockZoneId = 'bottom';

// =============================================================================
// Types
// =============================================================================

export interface AgenticSidebarContentProps {
  /** Whether the component is visible */
  visible?: boolean;
  /** Callback when a session completes */
  onSessionComplete?: () => void;
  /** Register new chat handler with parent */
  onRegisterNewChat?: (handler: () => void, canCreate: boolean) => void;
  /** Optional className */
  className?: string;
}

function resolveLatestParentRunId(
  snapshot: {
    session: { currentRunId: string | null };
    runs: Array<{ id: string; updatedAt: number }>;
  } | null,
): string | null {
  if (!snapshot) {
    return null;
  }

  if (snapshot.session.currentRunId) {
    return snapshot.session.currentRunId;
  }

  return [...snapshot.runs].sort((left, right) => right.updatedAt - left.updatedAt)[0]?.id ?? null;
}

function formatDelegationStatus(status: string): string {
  switch (status) {
    case 'requested':
      return 'Requested';
    case 'running':
      return 'Running';
    case 'completed':
      return 'Completed';
    case 'failed':
      return 'Failed';
    case 'cancelled':
      return 'Cancelled';
    default:
      return status;
  }
}

// =============================================================================
// Component
// =============================================================================

export function AgenticSidebarContent({
  visible = true,
  onSessionComplete,
  onRegisterNewChat,
  className = '',
}: AgenticSidebarContentProps) {
  const [showSessionList, setShowSessionList] = useState(false);
  const [chatSurfaceKey, setChatSurfaceKey] = useState(0);
  const [isSessionTransitionPending, setIsSessionTransitionPending] = useState(false);
  const [sessionTransitionLabel, setSessionTransitionLabel] = useState<
    'new' | 'switch' | 'delegate' | null
  >(null);
  const [projectPromptContext, setProjectPromptContext] = useState<ProjectPromptContext>({
    knowledge: [],
  });
  // ===========================================================================
  // Adapters
  // ===========================================================================

  const backendToolsEnabled = useFeatureFlag('USE_BACKEND_TOOLS');

  const llmClient = useMemo(() => {
    logger.info('Creating TauriLLMAdapter');
    return createTauriLLMAdapter();
  }, []);

  const toolExecutor = useMemo(() => {
    const frontend = createToolRegistryAdapter(globalToolRegistry);
    if (backendToolsEnabled) {
      logger.info('Creating BackendToolExecutor (editing tools → backend IPC)');
      return createBackendToolExecutor(frontend);
    }
    logger.info('Creating ToolRegistryAdapter (all tools → frontend)');
    return frontend;
  }, [backendToolsEnabled]);

  // ===========================================================================
  // Chat Handle Ref (for abort/isRunning access)
  // ===========================================================================

  const chatHandleRef = useRef<AgentRuntimeChatHandle>(null);
  const runtimePolicy = useSidebarRuntimePolicy();
  const currentProjectId = useProjectStore((state) => state.meta?.id ?? null);
  const currentProjectPath = useProjectStore((state) => state.meta?.path ?? null);
  const previousProjectIdRef = useRef<string | null>(currentProjectId);
  const activeSessionId = useConversationStore((state) => state.activeSessionId);
  const sessions = useConversationStore((state) => state.sessions);
  const activeConversationMessages = useConversationStore(
    (state) => state.activeConversation?.messages ?? EMPTY_MESSAGES,
  );
  const createSession = useConversationStore((state) => state.createSession);
  const switchSession = useConversationStore((state) => state.switchSession);
  const loadSessions = useConversationStore((state) => state.loadSessions);
  const addSystemMessage = useConversationStore((state) => state.addSystemMessage);
  const getLastUserInput = useConversationStore((state) => state.getLastUserInput);
  const clearQueuedMessages = useMessageQueueStore((state) => state.clear);
  const setArtifactReviewSelection = useAgentArtifactReviewStore((state) => state.setSelection);
  const clearArtifactReviewSelection = useAgentArtifactReviewStore((state) => state.clearSelection);
  const restorePanel = useWorkspaceLayoutStore((state) => state.restorePanel);
  const setActivePanel = useWorkspaceLayoutStore((state) => state.setActivePanel);
  const setZoneCollapsed = useWorkspaceLayoutStore((state) => state.setZoneCollapsed);
  const agentSnapshotsById = useAgentSessionStore((state) => state.snapshotsById);
  const loadAgentSession = useAgentSessionStore((state) => state.loadSession);
  const delegationRecords = useAgentDelegationStore((state): readonly DelegationRecord[] =>
    activeSessionId
      ? (state.recordsBySessionId[activeSessionId] ?? EMPTY_DELEGATIONS)
      : EMPTY_DELEGATIONS,
  );
  const loadDelegations = useAgentDelegationStore((state) => state.loadDelegations);
  const createDelegatedSession = useAgentDelegationStore((state) => state.createDelegatedSession);
  const updateDelegationRecord = useAgentDelegationStore((state) => state.updateDelegationRecord);
  const activeAgentProfileId = useMemo(
    () => sessions.find((session) => session.id === activeSessionId)?.agent ?? null,
    [activeSessionId, sessions],
  );
  const activeAgentSnapshot = useMemo(
    () => (activeSessionId ? (agentSnapshotsById[activeSessionId] ?? null) : null),
    [activeSessionId, agentSnapshotsById],
  );
  const activeAgentDefinition = useMemo(
    () => resolveAgentDefinition(activeAgentProfileId ?? DEFAULT_AGENT_PROFILE_ID),
    [activeAgentProfileId],
  );
  const specialistDefinitions = useMemo(() => listExperimentalSubAgentDefinitions(), []);
  const specialistDefinitionById = useMemo(
    () => new Map(specialistDefinitions.map((definition) => [definition.id, definition])),
    [specialistDefinitions],
  );
  const promptPlaceholder = useMemo(
    () => getAgentPromptPlaceholder(activeAgentProfileId ?? DEFAULT_AGENT_PROFILE_ID),
    [activeAgentProfileId],
  );

  const abortCurrentSession = useCallback(() => {
    clearQueuedMessages();
    chatHandleRef.current?.abort();
  }, [clearQueuedMessages]);

  useEffect(() => {
    const previousProjectId = previousProjectIdRef.current;
    previousProjectIdRef.current = currentProjectId;

    if (!previousProjectId || previousProjectId === currentProjectId) {
      return;
    }

    abortCurrentSession();
    clearArtifactReviewSelection();
    setChatSurfaceKey((prev) => prev + 1);
    setIsSessionTransitionPending(false);
    setSessionTransitionLabel(null);
  }, [abortCurrentSession, clearArtifactReviewSelection, currentProjectId]);

  const runSessionTransition = useCallback(
    async (label: 'new' | 'switch' | 'delegate', action: () => Promise<unknown>) => {
      setIsSessionTransitionPending(true);
      setSessionTransitionLabel(label);
      setChatSurfaceKey((prev) => prev + 1);

      try {
        await action();
      } finally {
        setIsSessionTransitionPending(false);
        setSessionTransitionLabel(null);
      }
    },
    [],
  );

  const openAgentReviewPanel = useCallback(() => {
    let targetZoneId = findPanelZone(
      useWorkspaceLayoutStore.getState().layout,
      AGENT_REVIEW_PANEL_ID,
    );
    if (!targetZoneId) {
      restorePanel(AGENT_REVIEW_PANEL_ID, DEFAULT_AGENT_REVIEW_ZONE);
      targetZoneId =
        findPanelZone(useWorkspaceLayoutStore.getState().layout, AGENT_REVIEW_PANEL_ID) ??
        DEFAULT_AGENT_REVIEW_ZONE;
    }

    setActivePanel(targetZoneId, AGENT_REVIEW_PANEL_ID);
    setZoneCollapsed(targetZoneId, false);
  }, [restorePanel, setActivePanel, setZoneCollapsed]);

  const openDelegationReview = useCallback(
    (input: {
      conversationId: string;
      title: string;
      agentProfileId: string;
      resultJson?: string | null;
    }) => {
      if (!currentProjectId) {
        return;
      }

      const resultPayload = parseDelegationResultPayload(input.resultJson);

      setArtifactReviewSelection({
        focus: resolveDelegationReviewFocus(resultPayload),
        projectId: currentProjectId,
        conversationId: input.conversationId,
        sourceLabel: input.title,
        sourceAgentProfileId: input.agentProfileId,
      });
      openAgentReviewPanel();
    },
    [currentProjectId, openAgentReviewPanel, setArtifactReviewSelection],
  );

  useEffect(() => {
    if (!activeSessionId) {
      return;
    }

    void loadDelegations(activeSessionId).catch((error) => {
      logger.warn('Failed to load delegation records', {
        sessionId: activeSessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }, [activeSessionId, loadDelegations]);

  // ===========================================================================
  // New Chat Hook
  // ===========================================================================

  const createNewSession = useCallback(
    (agentProfileId: string = DEFAULT_AGENT_PROFILE_ID) => {
      abortCurrentSession();
      void runSessionTransition('new', async () => {
        await createSession(agentProfileId, { preserveDraftConversation: false });
      });
    },
    [abortCurrentSession, createSession, runSessionTransition],
  );
  const canCreateNew = Boolean(currentProjectId) && !isSessionTransitionPending;

  const handleSessionSwitch = useCallback(
    (sessionId: string) => {
      if (sessionId === activeSessionId || isSessionTransitionPending) {
        return;
      }

      if (chatHandleRef.current?.isRunning) {
        abortCurrentSession();
      }

      void runSessionTransition('switch', async () => {
        await switchSession(sessionId);
      });
    },
    [
      abortCurrentSession,
      activeSessionId,
      isSessionTransitionPending,
      runSessionTransition,
      switchSession,
    ],
  );

  const handleDelegateToSpecialist = useCallback(
    async (agentProfileId: string) => {
      if (!activeSessionId || !currentProjectId) {
        createNewSession(agentProfileId);
        return;
      }

      const specialist = specialistDefinitionById.get(agentProfileId);
      if (!specialist) {
        createNewSession(agentProfileId);
        return;
      }

      const delegatedGoal =
        getLastUserInput()?.trim() || `Continue the current task using ${specialist.name}.`;

      let parentSnapshot = activeAgentSnapshot;
      if (!parentSnapshot) {
        try {
          parentSnapshot = await loadAgentSession(activeSessionId);
        } catch (error) {
          logger.warn('Failed to load parent agent session before delegation', {
            sessionId: activeSessionId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      const parentRunId = resolveLatestParentRunId(parentSnapshot);
      const parentLabel =
        activeAgentDefinition?.name ?? getAgentDisplayName(activeAgentProfileId ?? 'editor');

      addSystemMessage(`Delegated to ${specialist.name}: ${delegatedGoal}`);

      abortCurrentSession();
      void runSessionTransition('delegate', async () => {
        const { childSession, delegationRecord, delegationErrorMessage } =
          await createDelegatedSession({
            parentSessionId: activeSessionId,
            parentRunId,
            projectId: currentProjectId,
            sequenceId: parentSnapshot?.session.sequenceId ?? null,
            agentProfileId,
            title: `${specialist.name}: ${delegatedGoal.slice(0, 48)}`,
            delegatedGoal,
            contextPacketJson: JSON.stringify({
              source: 'agent-workspace',
              parentSessionId: activeSessionId,
              parentAgentId: activeAgentProfileId ?? DEFAULT_AGENT_PROFILE_ID,
              parentAgentName: parentLabel,
              delegatedGoal,
              createdAt: Date.now(),
            }),
          });

        try {
          await loadAgentSession(childSession.id);
        } catch (error) {
          logger.warn('Failed to hydrate delegated child session kernel', {
            sessionId: childSession.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }

        await loadSessions(currentProjectId);
        await switchSession(childSession.id);
        useConversationStore
          .getState()
          .addSystemMessage(`Delegated from ${parentLabel}. Goal: ${delegatedGoal}`);

        if (delegationRecord) {
          await loadDelegations(childSession.id).catch(() => {});
        } else if (delegationErrorMessage) {
          useConversationStore
            .getState()
            .addSystemMessage(`Delegation tracking unavailable: ${delegationErrorMessage}`);
        }
      });
    },
    [
      activeAgentDefinition?.name,
      activeAgentProfileId,
      activeAgentSnapshot,
      activeSessionId,
      addSystemMessage,
      abortCurrentSession,
      createDelegatedSession,
      createNewSession,
      currentProjectId,
      getLastUserInput,
      loadAgentSession,
      loadDelegations,
      loadSessions,
      runSessionTransition,
      specialistDefinitionById,
      switchSession,
    ],
  );

  const handleTrayStartSession = useCallback(
    (agentProfileId?: string) => {
      if (agentProfileId && specialistDefinitionById.has(agentProfileId)) {
        void handleDelegateToSpecialist(agentProfileId);
        return;
      }

      createNewSession(DEFAULT_AGENT_PROFILE_ID);
    },
    [createNewSession, handleDelegateToSpecialist, specialistDefinitionById],
  );

  const activeDelegationRecord = useMemo(
    () => delegationRecords.find((record) => record.childSessionId === activeSessionId) ?? null,
    [activeSessionId, delegationRecords],
  );
  const delegatedChildItems = useMemo(() => {
    if (!activeSessionId) {
      return [];
    }

    return delegationRecords
      .filter((record) => record.parentSessionId === activeSessionId)
      .map((record) => {
        const childSession = sessions.find((session) => session.id === record.childSessionId);
        const resultPayload = parseDelegationResultPayload(record.resultJson);
        return {
          id: record.id,
          label: childSession?.title || getAgentDisplayName(record.agentProfileId),
          delegatedGoal: record.delegatedGoal,
          statusLabel: formatDelegationStatus(record.status),
          resultPreview: resultPayload?.preview ?? resultPayload?.finalState ?? null,
          result: resultPayload,
          onOpen: () => handleSessionSwitch(record.childSessionId),
          onReview: () =>
            openDelegationReview({
              conversationId: record.childSessionId,
              title: childSession?.title || getAgentDisplayName(record.agentProfileId),
              agentProfileId: record.agentProfileId,
              resultJson: record.resultJson,
            }),
        };
      });
  }, [activeSessionId, delegationRecords, handleSessionSwitch, openDelegationReview, sessions]);
  const delegatedFromContext = useMemo(() => {
    const parentSessionId = activeAgentSnapshot?.session.lineage.parentSessionId;
    if (!parentSessionId) {
      return null;
    }

    const parentSession = sessions.find((session) => session.id === parentSessionId);
    const resultPayload = parseDelegationResultPayload(activeDelegationRecord?.resultJson);
    return {
      parentLabel: parentSession?.title || getAgentDisplayName(parentSession?.agent ?? 'editor'),
      delegatedGoal: activeDelegationRecord?.delegatedGoal ?? null,
      statusLabel: activeDelegationRecord
        ? formatDelegationStatus(activeDelegationRecord.status)
        : 'Delegated',
      resultPreview: resultPayload?.preview ?? resultPayload?.finalState ?? null,
      result: resultPayload,
      onReview: () =>
        openDelegationReview({
          conversationId: activeSessionId ?? parentSessionId,
          title:
            sessions.find((session) => session.id === activeSessionId)?.title ||
            activeAgentDefinition?.name ||
            'Delegated Session',
          agentProfileId: activeAgentProfileId ?? DEFAULT_AGENT_PROFILE_ID,
          resultJson: activeDelegationRecord?.resultJson ?? null,
        }),
      onReturnToParent: () => handleSessionSwitch(parentSessionId),
    };
  }, [
    activeAgentDefinition?.name,
    activeAgentProfileId,
    activeAgentSnapshot,
    activeDelegationRecord,
    activeSessionId,
    handleSessionSwitch,
    openDelegationReview,
    sessions,
  ]);

  // Register new chat handler with parent (AISidebar)
  useEffect(() => {
    onRegisterNewChat?.(() => createNewSession(DEFAULT_AGENT_PROFILE_ID), canCreateNew);
  }, [canCreateNew, createNewSession, onRegisterNewChat]);

  useEffect(() => {
    let isCancelled = false;

    if (!currentProjectId || !currentProjectPath) {
      setProjectPromptContext({ knowledge: [] });
      return () => {
        isCancelled = true;
      };
    }

    void loadProjectPromptContext(currentProjectId)
      .then((nextContext) => {
        if (!isCancelled) {
          setProjectPromptContext(nextContext);
        }
      })
      .catch((error) => {
        logger.warn('Failed to load project prompt context', {
          projectId: currentProjectId,
          error: error instanceof Error ? error.message : String(error),
        });
        if (!isCancelled) {
          setProjectPromptContext({ knowledge: [] });
        }
      });

    return () => {
      isCancelled = true;
    };
  }, [currentProjectId, currentProjectPath]);

  const chatPromptConfig = useMemo(
    () => ({
      knowledge: projectPromptContext.knowledge,
      customInstructions: projectPromptContext.customInstructions,
    }),
    [projectPromptContext.customInstructions, projectPromptContext.knowledge],
  );

  // ===========================================================================
  // Handlers
  // ===========================================================================

  const handleComplete = useCallback(
    (result: AgentRunResult) => {
      logger.info('Agentic session completed', { result });
      if (
        activeDelegationRecord &&
        (activeDelegationRecord.status === 'requested' ||
          activeDelegationRecord.status === 'running')
      ) {
        const liveMessages =
          useConversationStore.getState().activeConversation?.id ===
          activeDelegationRecord.childSessionId
            ? (useConversationStore.getState().activeConversation?.messages ?? EMPTY_MESSAGES)
            : activeConversationMessages;
        const resultPayload = buildDelegationResultPayload(result, liveMessages);
        void updateDelegationRecord({
          id: activeDelegationRecord.id,
          status: 'completed',
          summaryMessageId: resolveDelegationSummaryMessageId(liveMessages),
          resultJson: JSON.stringify(resultPayload),
          completedAt: Date.now(),
        }).catch((error) => {
          logger.warn('Failed to mark delegation completed', {
            delegationId: activeDelegationRecord.id,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
      onSessionComplete?.();
    },
    [activeConversationMessages, activeDelegationRecord, onSessionComplete, updateDelegationRecord],
  );

  const handleAbort = useCallback(() => {
    if (
      !activeDelegationRecord ||
      (activeDelegationRecord.status !== 'requested' && activeDelegationRecord.status !== 'running')
    ) {
      return;
    }

    const liveMessages =
      useConversationStore.getState().activeConversation?.id ===
      activeDelegationRecord.childSessionId
        ? (useConversationStore.getState().activeConversation?.messages ?? EMPTY_MESSAGES)
        : activeConversationMessages;

    void updateDelegationRecord({
      id: activeDelegationRecord.id,
      status: 'cancelled',
      summaryMessageId: resolveDelegationSummaryMessageId(liveMessages),
      errorMessage: 'Cancelled by user.',
      completedAt: Date.now(),
    }).catch((error) => {
      logger.warn('Failed to mark delegation cancelled', {
        delegationId: activeDelegationRecord.id,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }, [activeConversationMessages, activeDelegationRecord, updateDelegationRecord]);

  const handleError = useCallback(
    (error: Error) => {
      logger.error('Agentic session error', { error: error.message });
      if (
        activeDelegationRecord &&
        (activeDelegationRecord.status === 'requested' ||
          activeDelegationRecord.status === 'running')
      ) {
        const liveMessages =
          useConversationStore.getState().activeConversation?.id ===
          activeDelegationRecord.childSessionId
            ? (useConversationStore.getState().activeConversation?.messages ?? EMPTY_MESSAGES)
            : activeConversationMessages;
        void updateDelegationRecord({
          id: activeDelegationRecord.id,
          status: 'failed',
          summaryMessageId: resolveDelegationSummaryMessageId(liveMessages),
          resultJson: JSON.stringify({
            success: false,
            aborted: false,
            totalDuration: 0,
            iterations: 0,
            finalState: null,
            executedSteps: 0,
            successfulSteps: 0,
            failedSteps: 0,
            preview: error.message,
            recentTools: [],
            recentFiles: [],
          }),
          errorMessage: error.message,
          completedAt: Date.now(),
        }).catch((updateError) => {
          logger.warn('Failed to mark delegation failed', {
            delegationId: activeDelegationRecord.id,
            error: updateError instanceof Error ? updateError.message : String(updateError),
          });
        });
      }
    },
    [activeConversationMessages, activeDelegationRecord, updateDelegationRecord],
  );

  const handleSubmit = useCallback(
    (input: string) => {
      logger.info('User submitted input', { inputLength: input.length });
      if (activeDelegationRecord && activeDelegationRecord.status === 'requested') {
        void updateDelegationRecord({
          id: activeDelegationRecord.id,
          status: 'running',
        }).catch((error) => {
          logger.warn('Failed to mark delegation running', {
            delegationId: activeDelegationRecord.id,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
    },
    [activeDelegationRecord, updateDelegationRecord],
  );

  // ===========================================================================
  // Render
  // ===========================================================================

  if (!visible) {
    return null;
  }

  return (
    <div
      data-testid="agentic-sidebar-content"
      className={`flex flex-row flex-1 overflow-hidden ${className}`}
    >
      {/* Session List Panel */}
      {showSessionList && (
        <div className="w-[38%] max-w-[160px] min-w-[120px] flex-shrink-0 border-r border-border-subtle bg-surface-base">
          <SessionList onNewSession={createNewSession} onSwitchSession={handleSessionSwitch} />
        </div>
      )}

      {/* Main Chat Area */}
      <div className="flex flex-col flex-1 overflow-hidden">
        {/* Session toggle bar */}
        <div className="flex items-center px-2 py-1 border-b border-border-subtle bg-surface-base">
          <button
            onClick={() => setShowSessionList((prev) => !prev)}
            className="p-1 rounded hover:bg-surface-active transition-colors"
            aria-label={showSessionList ? 'Hide sessions' : 'Show sessions'}
            title={showSessionList ? 'Hide sessions' : 'Show sessions'}
            data-testid="toggle-sessions-btn"
          >
            {showSessionList ? (
              <PanelLeftClose className="w-3.5 h-3.5 text-text-tertiary" />
            ) : (
              <PanelLeftOpen className="w-3.5 h-3.5 text-text-tertiary" />
            )}
          </button>
          <div className="flex-1 flex min-w-0 overflow-hidden items-center gap-2">
            <span className="text-xs text-text-tertiary">Agent Workspace</span>
            {activeAgentDefinition && (
              <span className="rounded-full border border-border-subtle bg-surface-elevated px-1.5 py-0.5 text-[10px] font-medium text-text-secondary truncate">
                {activeAgentDefinition.name}
              </span>
            )}
          </div>
        </div>
        <AgentDelegationStrip
          delegatedFrom={delegatedFromContext}
          delegatedChildren={delegatedChildItems}
        />

        {runtimePolicy.selectedRuntime === 'disabled' ? (
          <div
            data-testid="agent-runtime-disabled-state"
            className="flex flex-1 items-center justify-center px-6 py-8"
          >
            <div className="max-w-sm text-center">
              <p className="text-sm font-medium text-text-primary">AI runtime is disabled</p>
              <p className="mt-2 text-xs text-text-secondary">
                Enable `USE_AGENTIC_ENGINE` to restore the canonical TPAO runtime.
              </p>
            </div>
          </div>
        ) : isSessionTransitionPending ? (
          <div
            data-testid="agent-session-transition-state"
            className="flex flex-1 items-center justify-center px-6 py-8"
          >
            <div className="max-w-sm text-center">
              <p className="text-sm font-medium text-text-primary">
                {sessionTransitionLabel === 'switch'
                  ? 'Opening session...'
                  : sessionTransitionLabel === 'delegate'
                    ? 'Delegating to specialist...'
                    : 'Starting new session...'}
              </p>
              <p className="mt-2 text-xs text-text-secondary">
                Preparing a clean agent workspace before the next turn.
              </p>
            </div>
          </div>
        ) : (
          <AgenticChat
            key={`agent-workspace-${chatSurfaceKey}`}
            ref={chatHandleRef}
            llmClient={llmClient}
            toolExecutor={toolExecutor}
            config={chatPromptConfig}
            onSubmit={handleSubmit}
            onComplete={handleComplete}
            onAbort={handleAbort}
            onError={handleError}
            placeholder={promptPlaceholder}
            disabled={isSessionTransitionPending}
            currentAgentName={activeAgentDefinition?.name ?? 'Editor'}
            currentAgentDescription={activeAgentDefinition?.description}
            isExperimentalSession={activeAgentDefinition?.mode === 'subagent'}
            specialistDefinitions={specialistDefinitions}
            onStartSession={handleTrayStartSession}
            className="flex-1"
          />
        )}
      </div>
    </div>
  );
}
