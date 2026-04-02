/**
 * AgentLoopChat Component
 *
 * Chat UI for the streaming AgentLoop runtime.
 */

import { useState, useCallback, useRef, useEffect, useImperativeHandle, forwardRef } from 'react';
import { useAgentLoopWithStores, type UseAgentLoopOptions } from '@/hooks/useAgentLoop';
import { useAgentLoopEventHandler } from '@/hooks/useAgentLoopEventHandler';
import { useConversationStore } from '@/stores/conversationStore';
import { useMessageQueueStore } from '@/stores/messageQueueStore';
import { useProjectStore } from '@/stores';
import type { ILLMClient, IToolExecutor, AgentContext } from '@/agents/engine';
import type { AgentLoopConfig } from '@/agents/engine/AgentLoop';
import { ChatMessageList } from './ChatMessageList';
import { ChatInputArea } from './ChatInputArea';
import { AgentSessionPersistenceBanner } from './AgentSessionPersistenceBanner';

const EMPTY_MESSAGES: readonly never[] = [];
const FORCE_STOP_WINDOW_MS = 1500;
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

export interface AgentLoopChatHandle {
  abort: () => void;
  isRunning: boolean;
}

export const AgentLoopChat = forwardRef<AgentLoopChatHandle, AgentLoopChatProps>(function AgentLoopChat(
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
  const [input, setInput] = useState('');
  const lastStopClickRef = useRef<number>(0);
  const [stopState, setStopState] = useState<'idle' | 'stopping'>('idle');

  const queueSize = useMessageQueueStore((state) => state.queue.length);
  const enqueue = useMessageQueueStore((state) => state.enqueue);
  const dequeue = useMessageQueueStore((state) => state.dequeue);
  const clearQueue = useMessageQueueStore((state) => state.clear);

  const messages = useConversationStore((state) => state.activeConversation?.messages ?? EMPTY_MESSAGES);
  const addUserMessage = useConversationStore((state) => state.addUserMessage);
  const addSystemMessage = useConversationStore((state) => state.addSystemMessage);

  const { handleEvent, handleAbort, reset } = useAgentLoopEventHandler();

  const {
    run,
    abort,
    approveToolPermission,
    retry,
    phase,
    isRunning,
    error,
    isEnabled,
  } = useAgentLoopWithStores({
    llmClient,
    toolExecutor,
    config,
    context,
    onEvent: handleEvent,
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

  useImperativeHandle(
    ref,
    () => ({
      abort,
      isRunning,
    }),
    [abort, isRunning],
  );

  const executeMessage = useCallback(
    async (message: string) => {
      if (!isEnabled) {
        return;
      }

      try {
        await run(message);
      } catch {
        // Error handling is delegated to the hook callbacks.
      }
    },
    [isEnabled, run],
  );

  const handleSubmit = useCallback(async () => {
    if (!input.trim() || disabled) {
      return;
    }

    const userInput = input.trim();
    setInput('');

    addUserMessage(userInput);
    onSubmit?.(userInput);

    if (isRunning) {
      enqueue(userInput);
      return;
    }

    await executeMessage(userInput);
  }, [addUserMessage, disabled, enqueue, executeMessage, input, isRunning, onSubmit]);

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
  }, [abort, addSystemMessage, clearQueue, stopState]);

  const handleRetry = useCallback(() => {
    void retry().catch(() => {});
  }, [retry]);
  const handleToolAllow = useCallback(() => approveToolPermission('allow'), [approveToolPermission]);
  const handleToolAllowAlways = useCallback(
    () => approveToolPermission('allow_always'),
    [approveToolPermission],
  );
  const handleToolDeny = useCallback(() => approveToolPermission('deny'), [approveToolPermission]);

  const currentProjectId = useProjectStore((state) => state.meta?.id ?? null);
  const activeProjectId = useConversationStore((state) => state.activeProjectId);
  const loadForProject = useConversationStore((state) => state.loadForProject);

  useEffect(() => {
    const targetProjectId = currentProjectId ?? 'default';
    if (activeProjectId !== targetProjectId) {
      loadForProject(targetProjectId);
    }
  }, [activeProjectId, currentProjectId, loadForProject]);

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
  }, [dequeue, executeMessage, isRunning]);

  useEffect(() => {
    return () => {
      reset();
    };
  }, [reset]);

  return (
    <div data-testid="agent-loop-chat" className={`flex flex-col h-full bg-surface-base ${className}`}>
      <AgentSessionPersistenceBanner />

      <ChatMessageList
        messages={messages}
        error={error}
        onApprove={NOOP}
        onReject={NOOP}
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
