/**
 * AgentLoopChat Component
 *
 * Compatibility-only fast-loop chat container used by internal
 * verification surfaces. Shared chat-shell behavior lives in
 * `AgentRuntimeChatShell`.
 */

import { useCallback, useMemo, forwardRef } from 'react';
import { useAgentLoopWithStores, type UseAgentLoopOptions } from '@/hooks/useAgentLoop';
import { useAgentLoopEventHandler } from '@/hooks/useAgentLoopEventHandler';
import { useConversationStore } from '@/stores/conversationStore';
import type { ILLMClient, IToolExecutor, AgentContext } from '@/agents/engine';
import type { AgentLoopConfig } from '@/agents/engine/AgentLoop';
import { DEFAULT_AGENT_PROFILE_ID } from '@/agents/engine';
import { resolveAgentDefinition } from '@/agents/engine/core/agentCatalog';
import { AgentRuntimeChatShell, type AgentRuntimeChatHandle } from './AgentRuntimeChatShell';

const NOOP = () => {};

export interface AgentLoopChatProps {
  llmClient: ILLMClient;
  toolExecutor: IToolExecutor;
  config?: Partial<AgentLoopConfig>;
  context?: Partial<AgentContext>;
  onSubmit?: (input: string) => void;
  onComplete?: UseAgentLoopOptions['onComplete'];
  onError?: UseAgentLoopOptions['onError'];
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}

export type AgentLoopChatHandle = AgentRuntimeChatHandle;

export const AgentLoopChat = forwardRef<AgentLoopChatHandle, AgentLoopChatProps>(
  function AgentLoopChat(
    {
      llmClient,
      toolExecutor,
      config,
      context,
      onSubmit,
      onComplete,
      onError,
      placeholder = 'Ask the AI to edit your video...',
      disabled = false,
      className = '',
    },
    ref,
  ) {
    const addSystemMessage = useConversationStore((state) => state.addSystemMessage);
    const activeSessionId = useConversationStore((state) => state.activeSessionId);
    const sessions = useConversationStore((state) => state.sessions);

    const { bindSession, handleEvent, handleAbort, reset } = useAgentLoopEventHandler();

    const {
      run,
      abort,
      approveToolPermission,
      retry,
      phase,
      isRunning,
      events,
      error,
      pendingToolPermissionRequest,
      isEnabled,
    } = useAgentLoopWithStores({
      llmClient,
      toolExecutor,
      config,
      context,
      onEvent: handleEvent,
      onSessionReady: bindSession,
      onComplete: (usage) => {
        onComplete?.(usage);
      },
      onError: (err) => {
        addSystemMessage(`Error: ${err.message}`);
        onError?.(err);
      },
      onAbort: () => {
        handleAbort();
      },
    });

    const handleRetry = useCallback(() => {
      void retry().catch(() => {});
    }, [retry]);
    const handleToolAllow = useCallback(
      () => approveToolPermission('allow'),
      [approveToolPermission],
    );
    const handleToolAllowAlways = useCallback(
      () => approveToolPermission('allow_always'),
      [approveToolPermission],
    );
    const handleToolDeny = useCallback(
      () => approveToolPermission('deny'),
      [approveToolPermission],
    );

    const runtimeSummary = useMemo(
      () => ({
        startedTools: events.filter((event) => event.type === 'tool_call_start').length,
        completedTools: events.filter((event) => event.type === 'tool_call_complete').length,
        latestIteration: events.filter((event) => event.type === 'tools_executed').length,
      }),
      [events],
    );
    const activeAgentDefinition = useMemo(
      () =>
        resolveAgentDefinition(
          sessions.find((session) => session.id === activeSessionId)?.agent ??
            DEFAULT_AGENT_PROFILE_ID,
        ),
      [activeSessionId, sessions],
    );

    return (
      <AgentRuntimeChatShell
        ref={ref}
        chatTestId="agent-loop-chat"
        executeMessage={async (message) => {
          try {
            await run(message);
          } catch {
            // Error handling is delegated to the hook callbacks.
          }
        }}
        abort={abort}
        phase={phase}
        isRunning={isRunning}
        isEnabled={isEnabled}
        error={error}
        runtimeSummary={runtimeSummary}
        plan={null}
        pendingClarificationQuestion={null}
        pendingToolPermissionRequest={pendingToolPermissionRequest}
        onSubmit={onSubmit}
        placeholder={placeholder}
        disabled={disabled}
        currentAgentName={activeAgentDefinition?.name ?? 'Editor'}
        currentAgentDescription={activeAgentDefinition?.description}
        isExperimentalSession={activeAgentDefinition?.mode === 'subagent'}
        specialistDefinitions={[]}
        className={className}
        clearQueueOnProjectSwitch
        clearQueueOnUnmount
        onUnmount={reset}
        onApprove={NOOP}
        onReject={NOOP}
        onRetry={handleRetry}
        onToolAllow={handleToolAllow}
        onToolAllowAlways={handleToolAllowAlways}
        onToolDeny={handleToolDeny}
      />
    );
  },
);
