/**
 * AgenticSidebarContent Component
 *
 * Content for the AI sidebar.
 * Renders the canonical TPAO runtime for the shipping AI sidebar.
 */

import { useState, useMemo, useCallback, useEffect, useRef, lazy, Suspense } from 'react';
import { X } from 'lucide-react';
import { AgenticChat } from './AgenticChat';
import { AgentArtifactReviewPanel } from './AgentArtifactReviewPanel';
import type { AgentRuntimeChatHandle } from './AgentRuntimeChatShell';
import { AgenticSidebarWorkspace } from './AgenticSidebarWorkspace';
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
import { useExternalAgentHostStatus } from '@/agents/external/useExternalAgentHostStatus';
import { useConversationStore, useProjectStore } from '@/stores';
import { useSettingsStore } from '@/stores/settingsStore';
import { useAgentArtifactReviewStore } from '@/stores/agentArtifactReviewStore';
import { useAgentSessionStore } from '@/stores/agentSessionStore';
import { useAgentDelegationStore } from '@/stores/agentDelegationStore';
import { useMessageQueueStore } from '@/stores/messageQueueStore';
import { createLogger } from '@/services/logger';
import {
  buildCancelledDelegationPayload,
  buildDelegationFailurePayload,
  buildDelegationResultPayload,
  parseDelegationResultPayload,
  resolveDelegationReviewFocus,
  resolveDelegationSummaryMessageId,
} from './agentDelegationResult';
import {
  buildDelegationContextPacket,
  buildDelegationContractSystemMessage,
} from './agentDelegationContract';
import {
  buildDelegatedChildItems,
  buildDelegatedFromContext,
  type OpenDelegationReviewInput,
} from './agentSidebarDelegationViewModels';
import { resolveLatestParentRunId } from './agentDelegationUi';
import { useAgentSessionTransition } from './useAgentSessionTransition';

// Lazy-loaded so the external/Codex agent host (and its heavy tool
// definitions) is only fetched when that runtime is actually selected.
const ExternalAgentChat = lazy(() =>
  import('./ExternalAgentChat').then((module) => ({ default: module.ExternalAgentChat })),
);

const logger = createLogger('AgenticSidebarContent');
const EMPTY_DELEGATIONS: readonly DelegationRecord[] = [];
const EMPTY_MESSAGES: readonly ConversationMessage[] = [];

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
  const [showArtifactReviewPanel, setShowArtifactReviewPanel] = useState(false);
  const [projectPromptContext, setProjectPromptContext] = useState<ProjectPromptContext>({
    knowledge: [],
  });
  // ===========================================================================
  // Adapters
  // ===========================================================================

  const backendToolsEnabled = useFeatureFlag('USE_BACKEND_TOOLS');
  const assistantRuntime = useSettingsStore((state) => state.settings.ai.assistantRuntime);
  const useCodexExternalRuntime = assistantRuntime === 'codex';
  const externalAgentStatus = useExternalAgentHostStatus({
    hostEnabled: useCodexExternalRuntime,
    codexEnabled: useCodexExternalRuntime,
  });
  const codexRuntimeSummary = useMemo(
    () =>
      externalAgentStatus.summary.runtimes.find((runtime) => runtime.runtimeId === 'codex') ?? null,
    [externalAgentStatus.summary.runtimes],
  );
  const codexRuntimeReady = Boolean(useCodexExternalRuntime && codexRuntimeSummary?.ready);
  const codexUnavailableReason = externalAgentStatus.loading
    ? 'Checking Codex availability...'
    : (codexRuntimeSummary?.reason ?? null);

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
  const {
    chatSurfaceKey,
    isSessionTransitionPending,
    sessionTransitionLabel,
    runSessionTransition,
    resetSessionTransition,
  } = useAgentSessionTransition();
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
  const addSystemMessageToSession = useConversationStore(
    (state) => state.addSystemMessageToSession,
  );
  const getLastUserInput = useConversationStore((state) => state.getLastUserInput);
  const clearQueuedMessages = useMessageQueueStore((state) => state.clear);
  const artifactReviewSelection = useAgentArtifactReviewStore((state) => state.selection);
  const setArtifactReviewSelection = useAgentArtifactReviewStore((state) => state.setSelection);
  const clearArtifactReviewSelection = useAgentArtifactReviewStore((state) => state.clearSelection);
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
    setShowArtifactReviewPanel(false);
    clearArtifactReviewSelection();
    resetSessionTransition({ bumpChatSurfaceKey: true });
  }, [abortCurrentSession, clearArtifactReviewSelection, currentProjectId, resetSessionTransition]);

  const openDelegationReview = useCallback(
    (input: OpenDelegationReviewInput) => {
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
      setShowArtifactReviewPanel(true);
    },
    [currentProjectId, setArtifactReviewSelection],
  );

  const closeArtifactReviewPanel = useCallback(() => {
    setShowArtifactReviewPanel(false);
    clearArtifactReviewSelection();
  }, [clearArtifactReviewSelection]);

  const shouldShowArtifactReviewPanel = Boolean(
    showArtifactReviewPanel &&
    currentProjectId &&
    artifactReviewSelection.projectId === currentProjectId &&
    artifactReviewSelection.conversationId,
  );

  useEffect(() => {
    if (!showArtifactReviewPanel) {
      return;
    }

    if (
      !artifactReviewSelection.conversationId ||
      (currentProjectId && artifactReviewSelection.projectId !== currentProjectId)
    ) {
      setShowArtifactReviewPanel(false);
    }
  }, [
    artifactReviewSelection.conversationId,
    artifactReviewSelection.projectId,
    currentProjectId,
    showArtifactReviewPanel,
  ]);

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
      if (chatHandleRef.current?.isRunning) {
        void createSession(agentProfileId, { preserveDraftConversation: false });
        return;
      }

      void runSessionTransition('new', async () => {
        await createSession(agentProfileId, { preserveDraftConversation: false });
      });
    },
    [createSession, runSessionTransition],
  );
  const createNewExternalSession = useCallback(() => {
    if (!codexRuntimeReady) {
      return;
    }

    if (chatHandleRef.current?.isRunning) {
      void createSession('codex', { preserveDraftConversation: false });
      return;
    }

    void runSessionTransition('new', async () => {
      await createSession('codex', { preserveDraftConversation: false });
    });
  }, [codexRuntimeReady, createSession, runSessionTransition]);
  const canCreateNew =
    Boolean(currentProjectId) &&
    !isSessionTransitionPending &&
    (!useCodexExternalRuntime || codexRuntimeReady);

  const handleSessionSwitch = useCallback(
    (sessionId: string) => {
      if (sessionId === activeSessionId || isSessionTransitionPending) {
        return;
      }

      void switchSession(sessionId);
    },
    [activeSessionId, isSessionTransitionPending, switchSession],
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
      const contextPacket = buildDelegationContextPacket({
        parentSessionId: activeSessionId,
        parentAgentId: activeAgentProfileId ?? DEFAULT_AGENT_PROFILE_ID,
        parentAgentName: parentLabel,
        delegatedGoal,
        specialistId: agentProfileId,
        specialistName: specialist.name,
      });
      const childBootstrapMessage = buildDelegationContractSystemMessage(contextPacket);

      addSystemMessage(`Delegated to ${specialist.name}: ${delegatedGoal}`);

      const transitionAction = async () => {
        const { childSession, delegationRecord, delegationErrorMessage } =
          await createDelegatedSession({
            parentSessionId: activeSessionId,
            parentRunId,
            projectId: currentProjectId,
            sequenceId: parentSnapshot?.session.sequenceId ?? null,
            agentProfileId,
            title: `${specialist.name}: ${delegatedGoal.slice(0, 48)}`,
            delegatedGoal,
            contextPacketJson: JSON.stringify(contextPacket),
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
        addSystemMessageToSession(childSession.id, childBootstrapMessage);

        if (delegationRecord) {
          await loadDelegations(childSession.id).catch(() => {});
        } else if (delegationErrorMessage) {
          useConversationStore
            .getState()
            .addSystemMessage(`Delegation tracking unavailable: ${delegationErrorMessage}`);
        }

        if (useConversationStore.getState().activeSessionId !== childSession.id) {
          useConversationStore
            .getState()
            .addSystemMessage(
              `Delegated session '${childSession.title}' was created, but the workspace could not switch into it automatically. Open it from Sessions to continue.`,
            );
        }
      };

      if (chatHandleRef.current?.isRunning) {
        void transitionAction();
        return;
      }

      void runSessionTransition('delegate', transitionAction);
    },
    [
      activeAgentDefinition?.name,
      activeAgentProfileId,
      activeAgentSnapshot,
      activeSessionId,
      addSystemMessage,
      addSystemMessageToSession,
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

  const handleWorkspaceNewSession = useCallback(
    (agentProfileId?: string) => {
      if (useCodexExternalRuntime) {
        createNewExternalSession();
        return;
      }

      createNewSession(agentProfileId ?? DEFAULT_AGENT_PROFILE_ID);
    },
    [createNewExternalSession, createNewSession, useCodexExternalRuntime],
  );

  const activeDelegationRecord = useMemo(
    () => delegationRecords.find((record) => record.childSessionId === activeSessionId) ?? null,
    [activeSessionId, delegationRecords],
  );
  const delegatedChildItems = useMemo(
    () =>
      buildDelegatedChildItems({
        activeSessionId,
        delegationRecords,
        sessions,
        handleSessionSwitch,
        openDelegationReview,
      }),
    [activeSessionId, delegationRecords, sessions, handleSessionSwitch, openDelegationReview],
  );
  const delegatedFromContext = useMemo(
    () =>
      buildDelegatedFromContext({
        activeAgentDefinitionName: activeAgentDefinition?.name,
        activeAgentProfileId,
        activeAgentSnapshot,
        activeDelegationRecord,
        activeSessionId,
        sessions,
        handleSessionSwitch,
        openDelegationReview,
      }),
    [
      activeAgentDefinition?.name,
      activeAgentProfileId,
      activeAgentSnapshot,
      activeDelegationRecord,
      activeSessionId,
      sessions,
      handleSessionSwitch,
      openDelegationReview,
    ],
  );

  // Register new chat handler with parent (AISidebar)
  useEffect(() => {
    onRegisterNewChat?.(() => handleWorkspaceNewSession(DEFAULT_AGENT_PROFILE_ID), canCreateNew);
  }, [canCreateNew, handleWorkspaceNewSession, onRegisterNewChat]);

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
        const resultPayload = buildDelegationResultPayload(result, liveMessages, {
          contextPacketJson: activeDelegationRecord.contextPacketJson,
          specialistId: activeDelegationRecord.agentProfileId,
        });
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
      resultJson: JSON.stringify(buildCancelledDelegationPayload('Cancelled by user.')),
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
          resultJson: JSON.stringify(buildDelegationFailurePayload(error.message)),
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

  const handleExternalComplete = useCallback(() => {
    logger.info('External agent session completed');
    onSessionComplete?.();
  }, [onSessionComplete]);

  const handleExternalAbort = useCallback(() => {
    logger.info('External agent session aborted');
  }, []);

  const handleExternalError = useCallback((error: Error) => {
    logger.error('External agent session error', { error: error.message });
  }, []);

  const workspaceRuntimeState = isSessionTransitionPending
    ? 'transitioning'
    : useCodexExternalRuntime
      ? codexRuntimeReady
        ? 'ready'
        : 'disabled'
      : runtimePolicy.selectedRuntime !== 'disabled'
        ? 'ready'
        : 'disabled';

  // ===========================================================================
  // Render
  // ===========================================================================

  if (!visible) {
    return null;
  }

  return (
    <AgenticSidebarWorkspace
      className={className}
      showSessionList={showSessionList}
      onToggleSessionList={() => setShowSessionList((prev) => !prev)}
      onNewSession={handleWorkspaceNewSession}
      onSwitchSession={handleSessionSwitch}
      canCreateNewSession={canCreateNew}
      activeAgentName={useCodexExternalRuntime ? 'Codex' : activeAgentDefinition?.name}
      delegatedFrom={delegatedFromContext}
      delegatedChildren={delegatedChildItems}
      runtimeState={workspaceRuntimeState}
      runtimeDisabledTitle={
        useCodexExternalRuntime ? 'Codex runtime is unavailable' : 'AI runtime is disabled'
      }
      runtimeDisabledDescription={
        useCodexExternalRuntime
          ? (codexUnavailableReason ?? 'Codex is not ready for external agent sessions.')
          : 'Enable `USE_AGENTIC_ENGINE` to restore the canonical TPAO runtime.'
      }
      sessionTransitionLabel={sessionTransitionLabel}
    >
      {shouldShowArtifactReviewPanel ? (
        <section
          className="flex min-h-0 flex-1 flex-col overflow-hidden bg-surface-base"
          data-testid="agent-review-inline-panel"
        >
          <div className="flex shrink-0 items-center justify-between border-b border-border-subtle px-3 py-2">
            <div className="min-w-0">
              <p className="truncate text-xs font-medium text-text-primary">Agent Review</p>
              {artifactReviewSelection.sourceLabel && (
                <p className="mt-0.5 truncate text-[11px] text-text-secondary">
                  {artifactReviewSelection.sourceLabel}
                </p>
              )}
            </div>
            <button
              type="button"
              onClick={closeArtifactReviewPanel}
              className="rounded p-1 text-text-tertiary transition-colors hover:bg-surface-active hover:text-text-primary"
              aria-label="Close agent review"
              title="Close agent review"
              data-testid="agent-review-inline-close-btn"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          <AgentArtifactReviewPanel className="min-h-0 flex-1" layout="compact" />
        </section>
      ) : useCodexExternalRuntime ? (
        <Suspense fallback={<div className="flex-1" />}>
          <ExternalAgentChat
            key={`external-agent-workspace-${chatSurfaceKey}`}
            ref={chatHandleRef}
            projectId={currentProjectId}
            projectPath={currentProjectPath}
            ready={codexRuntimeReady}
            unavailableReason={codexUnavailableReason}
            onComplete={handleExternalComplete}
            onAbort={handleExternalAbort}
            onError={handleExternalError}
            onStartSession={createNewExternalSession}
            disabled={
              isSessionTransitionPending || externalAgentStatus.loading || !codexRuntimeReady
            }
            className="flex-1"
          />
        </Suspense>
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
    </AgenticSidebarWorkspace>
  );
}
