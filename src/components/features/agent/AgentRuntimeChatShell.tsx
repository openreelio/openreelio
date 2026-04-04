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
  useRef,
  useState,
} from 'react';
import { useConversationStore } from '@/stores/conversationStore';
import { useMessageQueueStore } from '@/stores/messageQueueStore';
import { useProjectStore } from '@/stores';
import { ChatMessageList, type ChatMessageListProps } from './ChatMessageList';
import { ChatInputArea } from './ChatInputArea';
import { AgentSessionPersistenceBanner } from './AgentSessionPersistenceBanner';

const EMPTY_MESSAGES: readonly never[] = [];
const FORCE_STOP_WINDOW_MS = 1500;

export interface AgentRuntimeChatHandle {
  abort: () => void;
  isRunning: boolean;
}

type MessageActionProps = Pick<
  ChatMessageListProps,
  | 'onApprove'
  | 'onReject'
  | 'onRetry'
  | 'onToolAllow'
  | 'onToolAllowAlways'
  | 'onToolDeny'
>;

export interface AgentRuntimeChatShellProps extends MessageActionProps {
  chatTestId: string;
  executeMessage: (message: string) => Promise<void>;
  abort: () => void;
  phase: string;
  isRunning: boolean;
  isEnabled: boolean;
  error: Error | null;
  onSubmit?: (input: string) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  clearQueueOnProjectSwitch?: boolean;
  clearQueueOnUnmount?: boolean;
  onUnmount?: () => void;
}

export const AgentRuntimeChatShell = forwardRef<
  AgentRuntimeChatHandle,
  AgentRuntimeChatShellProps
>(function AgentRuntimeChatShell(
  {
    chatTestId,
    executeMessage,
    abort,
    phase,
    isRunning,
    isEnabled,
    error,
    onSubmit,
    placeholder = 'Ask the AI to edit your video...',
    disabled = false,
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
  const lastStopClickRef = useRef<number>(0);

  const queueSize = useMessageQueueStore((state) => state.queue.length);
  const enqueue = useMessageQueueStore((state) => state.enqueue);
  const dequeue = useMessageQueueStore((state) => state.dequeue);
  const clearQueue = useMessageQueueStore((state) => state.clear);

  const messages = useConversationStore(
    (state) => state.activeConversation?.messages ?? EMPTY_MESSAGES,
  );
  const addUserMessage = useConversationStore((state) => state.addUserMessage);
  const addSystemMessage = useConversationStore((state) => state.addSystemMessage);
  const activeProjectId = useConversationStore((state) => state.activeProjectId);
  const loadForProject = useConversationStore((state) => state.loadForProject);
  const currentProjectId = useProjectStore((state) => state.meta?.id ?? null);

  useImperativeHandle(
    ref,
    () => ({
      abort,
      isRunning,
    }),
    [abort, isRunning],
  );

  const handleSubmit = useCallback(async () => {
    if (!input.trim() || disabled || !isEnabled) {
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
  }, [
    addUserMessage,
    disabled,
    enqueue,
    executeMessage,
    input,
    isEnabled,
    isRunning,
    onSubmit,
  ]);

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

  useEffect(() => {
    const targetProjectId = currentProjectId ?? 'default';
    if (activeProjectId !== targetProjectId) {
      if (clearQueueOnProjectSwitch) {
        clearQueue();
      }
      loadForProject(targetProjectId);
    }
  }, [
    activeProjectId,
    clearQueue,
    clearQueueOnProjectSwitch,
    currentProjectId,
    loadForProject,
  ]);

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
      if (clearQueueOnUnmount) {
        clearQueue();
      }
      onUnmount?.();
    };
  }, [clearQueue, clearQueueOnUnmount, onUnmount]);

  return (
    <div data-testid={chatTestId} className={`flex flex-col h-full bg-surface-base ${className}`}>
      <AgentSessionPersistenceBanner />

      <ChatMessageList
        messages={messages}
        error={error}
        onApprove={onApprove}
        onReject={onReject}
        onRetry={onRetry}
        onToolAllow={onToolAllow}
        onToolAllowAlways={onToolAllowAlways}
        onToolDeny={onToolDeny}
      />

      <ChatInputArea
        input={input}
        onInputChange={setInput}
        onSubmit={() => void handleSubmit()}
        onStop={handleStop}
        placeholder={placeholder}
        disabled={disabled || !isEnabled}
        isRunning={isRunning}
        stopState={stopState}
        phase={phase}
        queueSize={queueSize}
      />
    </div>
  );
});
