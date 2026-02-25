/**
 * AgenticChat Component
 *
 * Main chat interface for the agentic AI loop.
 * Reads messages from conversationStore (unified message model)
 * and renders them with ConversationMessageItem.
 *
 * Features:
 * - PromptInput with @ mentions and / commands
 * - Always-enabled input (messages queue during execution)
 * - Auto-resize textarea (1-6 rows, Enter sends, Shift+Enter newline)
 * - Two-tier abort (graceful then force stop)
 * - Queue indicator with auto-dequeue
 */

import { useState, useCallback, useRef, useEffect, useImperativeHandle, forwardRef } from 'react';
import { useAgenticLoopWithStores, type UseAgenticLoopOptions } from '@/hooks/useAgenticLoop';
import { useAgentEventHandler } from '@/hooks/useAgentEventHandler';
import { useConversationStore } from '@/stores/conversationStore';
import { useMessageQueueStore } from '@/stores/messageQueueStore';
import { useProjectStore } from '@/stores';
import type { ILLMClient, IToolExecutor, AgentContext, AgenticEngineConfig } from '@/agents/engine';
import { ChatMessageList } from './ChatMessageList';
import { ChatInputArea } from './ChatInputArea';

// Stable reference to avoid infinite re-renders from Zustand selector
const EMPTY_MESSAGES: readonly never[] = [];

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
export interface AgenticChatHandle {
  abort: () => void;
  isRunning: boolean;
}

// =============================================================================
// Constants
// =============================================================================

const FORCE_STOP_WINDOW_MS = 1500;

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
  // State
  const [input, setInput] = useState('');
  const lastStopClickRef = useRef<number>(0);
  const [stopState, setStopState] = useState<'idle' | 'stopping'>('idle');

  // Message Queue
  const queueSize = useMessageQueueStore((s) => s.queue.length);
  const enqueue = useMessageQueueStore((s) => s.enqueue);
  const dequeue = useMessageQueueStore((s) => s.dequeue);
  const clearQueue = useMessageQueueStore((s) => s.clear);

  // Conversation Store
  const messages = useConversationStore((s) => s.activeConversation?.messages ?? EMPTY_MESSAGES);
  const addUserMessage = useConversationStore((s) => s.addUserMessage);
  const addSystemMessage = useConversationStore((s) => s.addSystemMessage);

  // Agent Event Handler
  const { handleEvent } = useAgentEventHandler();

  // Agentic Loop Hook
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

  // Expose handle to parent via ref
  useImperativeHandle(
    ref,
    () => ({
      abort,
      isRunning,
    }),
    [abort, isRunning],
  );

  // Execute a message (separated for queue reuse)
  const executeMessage = useCallback(
    async (message: string) => {
      if (!isEnabled) return;
      try {
        await run(message);
      } catch {
        // Error handled by onError callback
      }
    },
    [isEnabled, run],
  );

  // Handlers
  const handleSubmit = useCallback(async () => {
    if (!input.trim() || disabled) return;

    const userInput = input.trim();
    setInput('');

    addUserMessage(userInput);
    onSubmit?.(userInput);

    if (isRunning) {
      enqueue(userInput);
      return;
    }

    await executeMessage(userInput);
  }, [input, isRunning, disabled, addUserMessage, onSubmit, enqueue, executeMessage]);

  const handleStop = useCallback(() => {
    const now = Date.now();

    if (stopState === 'stopping' && now - lastStopClickRef.current < FORCE_STOP_WINDOW_MS) {
      abort();
      addSystemMessage('Operation force-stopped by user');
      setStopState('idle');
      clearQueue();
      return;
    }

    setStopState('stopping');
    lastStopClickRef.current = now;
    abort();
    addSystemMessage('Stopping after current step...');
  }, [stopState, abort, addSystemMessage, clearQueue]);

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

  // Effects: ensure conversationStore is initialized for active project
  const currentProjectId = useProjectStore((s) => s.meta?.id ?? null);
  const activeProjectId = useConversationStore((s) => s.activeProjectId);
  const loadForProject = useConversationStore((s) => s.loadForProject);

  useEffect(() => {
    const targetProjectId = currentProjectId ?? 'default';
    if (activeProjectId !== targetProjectId) {
      loadForProject(targetProjectId);
    }
  }, [currentProjectId, activeProjectId, loadForProject]);

  // Auto-dequeue: when engine finishes, run next queued message
  const prevIsRunningRef = useRef(isRunning);
  useEffect(() => {
    if (prevIsRunningRef.current && !isRunning) {
      setStopState('idle');
      const next = dequeue();
      if (next) {
        void executeMessage(next.content);
      }
    }
    prevIsRunningRef.current = isRunning;
  }, [isRunning, dequeue, executeMessage]);

  // Render
  return (
    <div data-testid="agentic-chat" className={`flex flex-col h-full bg-surface-base ${className}`}>
      <ChatMessageList
        messages={messages}
        error={error}
        onApprove={handleApprove}
        onReject={handleReject}
        onRetry={handleRetry}
        onToolAllow={handleToolAllow}
        onToolAllowAlways={handleToolAllowAlways}
        onToolDeny={handleToolDeny}
      />

      <ChatInputArea
        input={input}
        onInputChange={setInput}
        onSubmit={() => void handleSubmit()}
        onStop={handleStop}
        placeholder={placeholder}
        disabled={disabled}
        isRunning={isRunning}
        stopState={stopState}
        phase={phase}
        queueSize={queueSize}
      />
    </div>
  );
});
