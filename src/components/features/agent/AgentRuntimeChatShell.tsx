/**
 * AgentRuntimeChatShell
 *
 * Shared chat shell for the shipping TPAO and fast-loop runtimes.
 * Runtime-specific containers supply execution hooks and message actions.
 */

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { Plan } from '@/agents/engine';
import type { AgentDefinition } from '@/agents/engine/core/agentDefinitions';
import { useConversationStore } from '@/stores/conversationStore';
import { useMessageQueueStore } from '@/stores/messageQueueStore';
import { useProjectStore } from '@/stores';
import { useAgentArtifactReviewStore } from '@/stores/agentArtifactReviewStore';
import { revealWorkspacePanel, type DockZoneId, type PanelId } from '@/stores/workspaceLayoutStore';
import { ChatMessageList, type ChatMessageListProps } from './ChatMessageList';
import { ChatInputArea } from './ChatInputArea';
import { AgentArtifactFocusBanner } from './AgentArtifactFocusBanner';
import { AgentArtifactDetailPanel } from './AgentArtifactDetailPanel';
import { AgentSessionPersistenceBanner } from './AgentSessionPersistenceBanner';
import { AgentSessionArtifactSummary } from './AgentSessionArtifactSummary';
import type { AgentRuntimePermissionRequest, AgentRuntimeSummary } from './AgentComposerTray';
import { isSameArtifactFocus, type AgentArtifactFocus } from './agentArtifactFocus';

const EMPTY_MESSAGES: readonly never[] = [];
const AGENT_REVIEW_PANEL_ID: PanelId = 'agent-review';
const DEFAULT_AGENT_REVIEW_ZONE: DockZoneId = 'bottom';

export interface AgentRuntimeChatHandle {
  abort: () => void;
  isRunning: boolean;
}

type MessageActionProps = Pick<
  ChatMessageListProps,
  'onApprove' | 'onReject' | 'onRetry' | 'onToolAllow' | 'onToolAllowAlways' | 'onToolDeny'
>;

export interface AgentRuntimeChatShellProps extends MessageActionProps {
  chatTestId: string;
  executeMessage: (message: string) => Promise<void>;
  abort: () => void;
  phase: string;
  isRunning: boolean;
  isEnabled: boolean;
  error: Error | null;
  runtimeSummary: AgentRuntimeSummary;
  plan: Plan | null;
  pendingClarificationQuestion: string | null;
  pendingToolPermissionRequest: AgentRuntimePermissionRequest | null;
  onSubmit?: (input: string) => void;
  placeholder?: string;
  disabled?: boolean;
  currentAgentName?: string;
  currentAgentDescription?: string;
  isExperimentalSession?: boolean;
  specialistDefinitions?: Array<Pick<AgentDefinition, 'id' | 'name' | 'description'>>;
  onStartSession?: (agentProfileId?: string) => void;
  className?: string;
  clearQueueOnProjectSwitch?: boolean;
  clearQueueOnUnmount?: boolean;
  onUnmount?: () => void;
}

export const AgentRuntimeChatShell = forwardRef<AgentRuntimeChatHandle, AgentRuntimeChatShellProps>(
  function AgentRuntimeChatShell(
    {
      chatTestId,
      executeMessage,
      abort,
      phase,
      isRunning,
      isEnabled,
      error,
      runtimeSummary,
      plan,
      pendingClarificationQuestion,
      pendingToolPermissionRequest,
      onSubmit,
      placeholder = 'Ask the AI to edit your video...',
      disabled = false,
      currentAgentName = 'Editor',
      currentAgentDescription,
      isExperimentalSession = false,
      specialistDefinitions = [],
      onStartSession,
      className = '',
      clearQueueOnProjectSwitch = false,
      clearQueueOnUnmount = false,
      onUnmount,
      onApprove,
      onReject,
      onRetry,
      onToolAllow,
      onToolAllowAlways,
      onToolDeny,
    },
    ref,
  ) {
    const [input, setInput] = useState('');
    const [stopState, setStopState] = useState<'idle' | 'stopping'>('idle');

    const queueSize = useMessageQueueStore((state) => state.queue.length);
    const enqueue = useMessageQueueStore((state) => state.enqueue);
    const dequeue = useMessageQueueStore((state) => state.dequeue);
    const clearQueue = useMessageQueueStore((state) => state.clear);

    const messages = useConversationStore(
      (state) => state.activeConversation?.messages ?? EMPTY_MESSAGES,
    );
    const activeConversationId = useConversationStore(
      (state) => state.activeConversation?.id ?? null,
    );
    const addUserMessage = useConversationStore((state) => state.addUserMessage);
    const persistQueuedMessage = useConversationStore((state) => state.persistQueuedMessage);
    const addSystemMessage = useConversationStore((state) => state.addSystemMessage);
    const activeProjectId = useConversationStore((state) => state.activeProjectId);
    const loadForProject = useConversationStore((state) => state.loadForProject);
    const currentProjectId = useProjectStore((state) => state.meta?.id ?? null);
    const artifactSelection = useAgentArtifactReviewStore((state) => state.selection);
    const setArtifactSelection = useAgentArtifactReviewStore((state) => state.setSelection);
    const clearArtifactSelection = useAgentArtifactReviewStore((state) => state.clearSelection);
    const previousProjectIdRef = useRef(currentProjectId);

    const artifactFocus = useMemo(() => {
      if (!artifactSelection.focus) {
        return null;
      }

      if (
        artifactSelection.projectId !== activeProjectId ||
        artifactSelection.conversationId !== activeConversationId
      ) {
        return null;
      }

      return artifactSelection.focus;
    }, [activeConversationId, activeProjectId, artifactSelection]);

    useImperativeHandle(
      ref,
      () => ({
        abort,
        isRunning,
      }),
      [abort, isRunning],
    );

    const handleSubmit = useCallback(async () => {
      if (!input.trim() || disabled || !isEnabled || stopState === 'stopping') {
        return;
      }

      const userInput = input.trim();
      const targetProjectId = currentProjectId ?? 'default';

      if (activeProjectId !== targetProjectId || !activeConversationId) {
        loadForProject(targetProjectId);
      }

      setInput('');

      if (isRunning) {
        const currentState = useConversationStore.getState();
        const queuedMessageId = addUserMessage(userInput, { persist: false });
        enqueue(userInput, {
          projectId: currentState.activeProjectId,
          sessionId: currentState.activeSessionId,
          conversationId: currentState.activeConversation?.id ?? null,
          messageId: queuedMessageId,
        });
        onSubmit?.(userInput);
        return;
      }

      addUserMessage(userInput);
      onSubmit?.(userInput);

      await executeMessage(userInput);
    }, [
      activeConversationId,
      activeProjectId,
      addUserMessage,
      currentProjectId,
      disabled,
      enqueue,
      executeMessage,
      input,
      isEnabled,
      isRunning,
      loadForProject,
      onSubmit,
      stopState,
    ]);

    const handleStop = useCallback(() => {
      if (stopState === 'stopping') {
        return;
      }

      setStopState('stopping');
      clearQueue();
      abort();
      addSystemMessage(
        queueSize > 0
          ? `Operation stopped by user. Cleared ${queueSize} queued message${queueSize === 1 ? '' : 's'}.`
          : 'Operation stopped by user.',
      );
    }, [abort, addSystemMessage, clearQueue, queueSize, stopState]);

    useEffect(() => {
      const targetProjectId = currentProjectId ?? 'default';
      const previousProjectId = previousProjectIdRef.current;
      previousProjectIdRef.current = currentProjectId;

      if (previousProjectId && previousProjectId !== currentProjectId && isRunning) {
        clearQueue();
        abort();
      }

      if (activeProjectId !== targetProjectId) {
        if (clearQueueOnProjectSwitch) {
          clearQueue();
        }
        loadForProject(targetProjectId);
      }
    }, [
      abort,
      activeProjectId,
      clearQueue,
      clearQueueOnProjectSwitch,
      currentProjectId,
      isRunning,
      loadForProject,
    ]);

    const prevIsRunningRef = useRef(isRunning);
    useEffect(() => {
      if (prevIsRunningRef.current && !isRunning) {
        if (stopState === 'stopping') {
          setStopState('idle');
          prevIsRunningRef.current = isRunning;
          return;
        }

        setStopState('idle');
        let next = dequeue();
        while (next) {
          const currentState = useConversationStore.getState();
          const stillMatchesProject =
            !next.projectId || next.projectId === currentState.activeProjectId;
          const stillMatchesSession =
            !next.sessionId || next.sessionId === currentState.activeSessionId;
          const stillMatchesConversation =
            !next.conversationId || next.conversationId === currentState.activeConversation?.id;

          if (stillMatchesProject && stillMatchesSession && stillMatchesConversation) {
            if (next.messageId) {
              persistQueuedMessage(next.messageId, next.sessionId);
            }
            void executeMessage(next.content);
            break;
          }

          next = dequeue();
        }
      }
      prevIsRunningRef.current = isRunning;
    }, [dequeue, executeMessage, isRunning, persistQueuedMessage, stopState]);

    useEffect(() => {
      return () => {
        if (clearQueueOnUnmount) {
          clearQueue();
        }
        onUnmount?.();
      };
    }, [clearQueue, clearQueueOnUnmount, onUnmount]);

    const openAgentReviewPanel = useCallback(() => {
      revealWorkspacePanel(AGENT_REVIEW_PANEL_ID, DEFAULT_AGENT_REVIEW_ZONE);
    }, []);

    const handleArtifactFocus = useCallback(
      (focus: AgentArtifactFocus) => {
        if (isSameArtifactFocus(artifactFocus, focus)) {
          clearArtifactSelection();
          return;
        }

        setArtifactSelection({
          focus,
          projectId: activeProjectId,
          conversationId: activeConversationId,
        });
        openAgentReviewPanel();
      },
      [
        activeConversationId,
        activeProjectId,
        artifactFocus,
        clearArtifactSelection,
        openAgentReviewPanel,
        setArtifactSelection,
      ],
    );

    return (
      <div
        data-testid={chatTestId}
        className={`flex h-full min-w-0 flex-col bg-surface-base ${className}`}
      >
        <AgentSessionPersistenceBanner />
        <AgentSessionArtifactSummary
          messages={messages}
          activeArtifactFocus={artifactFocus}
          onSelectArtifact={handleArtifactFocus}
        />
        {artifactFocus && (
          <AgentArtifactFocusBanner focus={artifactFocus} onClear={clearArtifactSelection} />
        )}
        <AgentArtifactDetailPanel messages={messages} focus={artifactFocus} />

        <ChatMessageList
          messages={messages}
          conversationId={activeConversationId}
          error={error}
          onApprove={onApprove}
          onReject={onReject}
          onRetry={onRetry}
          onToolAllow={onToolAllow}
          onToolAllowAlways={onToolAllowAlways}
          onToolDeny={onToolDeny}
          artifactFocus={artifactFocus}
        />

        <ChatInputArea
          input={input}
          onInputChange={setInput}
          onSubmit={() => void handleSubmit()}
          onStop={handleStop}
          onApprove={onApprove}
          onReject={onReject}
          onToolAllow={onToolAllow}
          onToolAllowAlways={onToolAllowAlways}
          onToolDeny={onToolDeny}
          placeholder={placeholder}
          disabled={disabled || !isEnabled || stopState === 'stopping'}
          isRunning={isRunning}
          stopState={stopState}
          currentAgentName={currentAgentName}
          currentAgentDescription={currentAgentDescription}
          isExperimentalSession={isExperimentalSession}
          specialistDefinitions={specialistDefinitions}
          onStartSession={onStartSession}
          phase={phase}
          runtimeSummary={runtimeSummary}
          pendingPlan={plan}
          pendingClarificationQuestion={pendingClarificationQuestion}
          pendingToolPermissionRequest={pendingToolPermissionRequest}
          queueSize={queueSize}
        />
      </div>
    );
  },
);
