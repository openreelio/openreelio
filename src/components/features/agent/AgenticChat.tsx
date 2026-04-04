/**
 * AgenticChat
 *
 * Shipping TPAO chat container. Shared chat-shell behavior lives in
 * `AgentRuntimeChatShell`.
 */

import { useCallback, forwardRef } from 'react';
import { useAgenticLoopWithStores, type UseAgenticLoopOptions } from '@/hooks/useAgenticLoop';
import { useAgentEventHandler } from '@/hooks/useAgentEventHandler';
import { useConversationStore } from '@/stores/conversationStore';
import type { ILLMClient, IToolExecutor, AgentContext, AgenticEngineConfig } from '@/agents/engine';
import {
  AgentRuntimeChatShell,
  type AgentRuntimeChatHandle,
} from './AgentRuntimeChatShell';

// =============================================================================
// Types
// =============================================================================

export interface AgenticChatProps {
  /** LLM client to use */
  llmClient: ILLMClient;
  /** Tool executor to use */
  toolExecutor: IToolExecutor;
  /** Engine configuration */
  config?: Partial<AgenticEngineConfig>;
  /** Additional context */
  context?: Partial<AgentContext>;
  /** Called when user submits a message */
  onSubmit?: (input: string) => void;
  /** Called when run completes */
  onComplete?: UseAgenticLoopOptions['onComplete'];
  /** Called on error */
  onError?: UseAgenticLoopOptions['onError'];
  /** Placeholder text for input */
  placeholder?: string;
  /** Whether the chat is disabled */
  disabled?: boolean;
  /** Optional className */
  className?: string;
}

/** Imperative handle exposed to parent components */
export type AgenticChatHandle = AgentRuntimeChatHandle;

// =============================================================================
// Component
// =============================================================================

export const AgenticChat = forwardRef<AgenticChatHandle, AgenticChatProps>(function AgenticChat(
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
  const addSystemMessage = useConversationStore((s) => s.addSystemMessage);

  const { handleEvent } = useAgentEventHandler();

  const {
    run,
    abort,
    approvePlan,
    rejectPlan,
    approveToolPermission,
    retry,
    phase,
    isRunning,
    error,
    isEnabled,
  } = useAgenticLoopWithStores({
    llmClient,
    toolExecutor,
    config,
    context,
    onEvent: handleEvent,
    onComplete: (result) => {
      onComplete?.(result);
    },
    onError: (err) => {
      addSystemMessage(`Error: ${err.message}`);
      onError?.(err);
    },
    onApprovalRequired: () => {
      // Approval is handled through part renderers
    },
  });

  const handleApprove = useCallback(() => approvePlan(), [approvePlan]);
  const handleReject = useCallback(
    (reason?: string) => {
      rejectPlan(reason ?? 'User rejected the plan');
      addSystemMessage('Plan rejected');
    },
    [rejectPlan, addSystemMessage],
  );
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
  const handleToolDeny = useCallback(() => approveToolPermission('deny'), [approveToolPermission]);

  return (
    <AgentRuntimeChatShell
      ref={ref}
      chatTestId="agentic-chat"
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
      onSubmit={onSubmit}
      placeholder={placeholder}
      disabled={disabled}
      className={className}
      onApprove={handleApprove}
      onReject={handleReject}
      onRetry={handleRetry}
      onToolAllow={handleToolAllow}
      onToolAllowAlways={handleToolAllowAlways}
      onToolDeny={handleToolDeny}
    />
  );
});
