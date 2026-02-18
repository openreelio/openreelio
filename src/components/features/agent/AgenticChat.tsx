/**
 * AgenticChat Component
 *
 * Main chat interface for the agentic AI loop.
 * Reads messages from conversationStore (unified message model)
 * and renders them with ConversationMessageItem.
 *
 * Features:
 * - Always-enabled textarea input (messages queue during execution)
 * - Auto-resize textarea (1-6 rows, Enter sends, Shift+Enter newline)
 * - Two-tier abort (graceful then force stop)
 * - Queue indicator with auto-dequeue
 */

import {
  useState,
  useCallback,
  useRef,
  useEffect,
  useImperativeHandle,
  forwardRef,
} from 'react';
import { Square, Send } from 'lucide-react';
import { useAgenticLoopWithStores, type UseAgenticLoopOptions } from '@/hooks/useAgenticLoop';
import { useAgentEventHandler } from '@/hooks/useAgentEventHandler';
import { useConversationStore } from '@/stores/conversationStore';
import { useMessageQueueStore } from '@/stores/messageQueueStore';
import { useProjectStore } from '@/stores';
import type { ILLMClient, IToolExecutor, AgentContext, AgenticEngineConfig } from '@/agents/engine';
import { ConversationMessageItem } from './ConversationMessageItem';

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

const TEXTAREA_MIN_ROWS = 1;
const TEXTAREA_MAX_ROWS = 6;
const TEXTAREA_LINE_HEIGHT = 20; // px
const FORCE_STOP_WINDOW_MS = 1500;

// =============================================================================
// Component
// =============================================================================

export const AgenticChat = forwardRef<AgenticChatHandle, AgenticChatProps>(
  function AgenticChat(
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
    // =========================================================================
    // State
    // =========================================================================

    const [input, setInput] = useState('');
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const scrollContainerRef = useRef<HTMLDivElement>(null);
    const isUserScrolledUpRef = useRef(false);
    const lastStopClickRef = useRef<number>(0);
    const [stopState, setStopState] = useState<'idle' | 'stopping'>('idle');

    // =========================================================================
    // Message Queue
    // =========================================================================

    const queueSize = useMessageQueueStore((s) => s.queue.length);
    const enqueue = useMessageQueueStore((s) => s.enqueue);
    const dequeue = useMessageQueueStore((s) => s.dequeue);
    const clearQueue = useMessageQueueStore((s) => s.clear);

    // =========================================================================
    // Conversation Store
    // =========================================================================

    const messages = useConversationStore(
      (s) => s.activeConversation?.messages ?? EMPTY_MESSAGES,
    );
    const addUserMessage = useConversationStore((s) => s.addUserMessage);
    const addSystemMessage = useConversationStore((s) => s.addSystemMessage);

    // =========================================================================
    // Agent Event Handler
    // =========================================================================

    const { handleEvent } = useAgentEventHandler();

    // =========================================================================
    // Agentic Loop Hook
    // =========================================================================

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

    // =========================================================================
    // Expose handle to parent via ref
    // =========================================================================

    useImperativeHandle(
      ref,
      () => ({
        abort,
        isRunning,
      }),
      [abort, isRunning],
    );

    // =========================================================================
    // Scroll Logic
    // =========================================================================

    const scrollToBottom = useCallback(() => {
      if (isUserScrolledUpRef.current) return;
      if (
        messagesEndRef.current &&
        typeof messagesEndRef.current.scrollIntoView === 'function'
      ) {
        messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
      }
    }, []);

    const handleScroll = useCallback(() => {
      const container = scrollContainerRef.current;
      if (!container) return;
      const threshold = 100;
      const isAtBottom =
        container.scrollHeight - container.scrollTop - container.clientHeight <
        threshold;
      isUserScrolledUpRef.current = !isAtBottom;
    }, []);

    // =========================================================================
    // Textarea Auto-Resize
    // =========================================================================

    const resizeTextarea = useCallback(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;

      // Reset height to auto so scrollHeight recalculates
      textarea.style.height = 'auto';

      const minHeight = TEXTAREA_LINE_HEIGHT * TEXTAREA_MIN_ROWS;
      const maxHeight = TEXTAREA_LINE_HEIGHT * TEXTAREA_MAX_ROWS;
      const newHeight = Math.min(
        Math.max(textarea.scrollHeight, minHeight),
        maxHeight,
      );

      textarea.style.height = `${newHeight}px`;
    }, []);

    // =========================================================================
    // Execute a message (separated for queue reuse)
    // =========================================================================

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

    // =========================================================================
    // Handlers
    // =========================================================================

    const handleSubmit = useCallback(async () => {
      if (!input.trim() || disabled) return;

      const userInput = input.trim();
      setInput('');

      // Reset textarea height
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
      }

      // Add user message to conversation
      addUserMessage(userInput);
      onSubmit?.(userInput);

      if (isRunning) {
        // Queue for later execution
        enqueue(userInput);
        return;
      }

      // Execute immediately
      await executeMessage(userInput);
    }, [
      input,
      isRunning,
      disabled,
      addUserMessage,
      onSubmit,
      enqueue,
      executeMessage,
    ]);

    const handleKeyDown = useCallback(
      (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          void handleSubmit();
        }
      },
      [handleSubmit],
    );

    const handleInputChange = useCallback(
      (e: React.ChangeEvent<HTMLTextAreaElement>) => {
        setInput(e.target.value);
      },
      [],
    );

    const handleStop = useCallback(() => {
      const now = Date.now();

      if (stopState === 'stopping' && now - lastStopClickRef.current < FORCE_STOP_WINDOW_MS) {
        // Force stop
        abort();
        addSystemMessage('Operation force-stopped by user');
        setStopState('idle');
        clearQueue();
        return;
      }

      // Graceful stop: set flag, let current step finish
      setStopState('stopping');
      lastStopClickRef.current = now;
      abort();
      addSystemMessage('Stopping after current step...');
    }, [stopState, abort, addSystemMessage, clearQueue]);

    const handleApprove = useCallback(() => {
      approvePlan();
    }, [approvePlan]);

    const handleReject = useCallback(
      (reason?: string) => {
        rejectPlan(reason ?? 'User rejected the plan');
        addSystemMessage('Plan rejected');
      },
      [rejectPlan, addSystemMessage],
    );

    const handleRetry = useCallback(() => {
      void retry().catch(() => {
        // errors are surfaced via onError callback
      });
    }, [retry]);

    const handleToolAllow = useCallback(() => {
      approveToolPermission('allow');
    }, [approveToolPermission]);

    const handleToolAllowAlways = useCallback(() => {
      approveToolPermission('allow_always');
    }, [approveToolPermission]);

    const handleToolDeny = useCallback(() => {
      approveToolPermission('deny');
    }, [approveToolPermission]);

    // =========================================================================
    // Effects
    // =========================================================================

    // Ensure conversationStore is initialized for the active project
    const currentProjectId = useProjectStore((s) => s.meta?.id ?? null);
    const activeProjectId = useConversationStore((s) => s.activeProjectId);
    const loadForProject = useConversationStore((s) => s.loadForProject);

    useEffect(() => {
      const targetProjectId =
        currentProjectId ?? activeProjectId ?? 'default';
      if (activeProjectId !== targetProjectId) {
        loadForProject(targetProjectId);
      }
    }, [currentProjectId, activeProjectId, loadForProject]);

    // Scroll to bottom on new messages
    useEffect(() => {
      scrollToBottom();
    }, [messages, scrollToBottom]);

    // Focus input on mount
    useEffect(() => {
      if (!disabled) {
        textareaRef.current?.focus();
      }
    }, [disabled]);

    // Auto-resize textarea on input change
    useEffect(() => {
      resizeTextarea();
    }, [input, resizeTextarea]);

    // Auto-dequeue: when engine finishes, run next queued message
    const prevIsRunningRef = useRef(isRunning);
    useEffect(() => {
      if (prevIsRunningRef.current && !isRunning) {
        // Engine just stopped — check queue
        setStopState('idle');
        const next = dequeue();
        if (next) {
          void executeMessage(next.content);
        }
      }
      prevIsRunningRef.current = isRunning;
    }, [isRunning, dequeue, executeMessage]);

    // =========================================================================
    // Phase display
    // =========================================================================

    const getPhaseLabel = (): string => {
      if (stopState === 'stopping') return 'Stopping...';
      switch (phase) {
        case 'thinking':
          return 'Thinking...';
        case 'planning':
          return 'Planning...';
        case 'awaiting_approval':
          return 'Awaiting approval';
        case 'executing':
          return 'Executing...';
        case 'observing':
          return 'Observing results...';
        default:
          return phase.replace(/_/g, ' ');
      }
    };

    // =========================================================================
    // Render
    // =========================================================================

    return (
      <div
        data-testid="agentic-chat"
        className={`flex flex-col h-full bg-surface-base ${className}`}
      >
        {/* Messages Area */}
        <div
          ref={scrollContainerRef}
          onScroll={handleScroll}
          className="flex-1 overflow-y-auto p-4 space-y-4"
        >
          {messages.map((message) => (
            <ConversationMessageItem
              key={message.id}
              message={message}
              onApprove={handleApprove}
              onReject={handleReject}
              onRetry={handleRetry}
              onToolAllow={handleToolAllow}
              onToolAllowAlways={handleToolAllowAlways}
              onToolDeny={handleToolDeny}
            />
          ))}

          {/* Error Display */}
          {error && (
            <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-lg">
              <p className="text-sm text-red-400">{error.message}</p>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        {/* Input Area */}
        <div className="border-t border-border-subtle p-4">
          {/* Queue indicator */}
          {queueSize > 0 && (
            <div className="mb-2 flex items-center gap-2">
              <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs bg-primary-500/10 text-primary-400 rounded-full">
                {queueSize} queued
              </span>
            </div>
          )}

          <div className="flex gap-2 items-end">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              placeholder={placeholder}
              disabled={disabled}
              rows={1}
              className={`
                flex-1 px-4 py-2 rounded-lg resize-none
                bg-surface-elevated border border-border-subtle
                text-text-primary placeholder-text-tertiary
                focus:outline-none focus:ring-2 focus:ring-primary-500/50 focus:border-primary-500
                disabled:opacity-50 disabled:cursor-not-allowed
                transition-colors
              `}
              style={{
                lineHeight: `${TEXTAREA_LINE_HEIGHT}px`,
                minHeight: `${TEXTAREA_LINE_HEIGHT * TEXTAREA_MIN_ROWS + 16}px`,
                maxHeight: `${TEXTAREA_LINE_HEIGHT * TEXTAREA_MAX_ROWS + 16}px`,
              }}
              data-testid="agentic-chat-input"
            />

            <div className="flex gap-1">
              {isRunning && (
                <button
                  onClick={handleStop}
                  className={`p-2 rounded-lg transition-colors ${
                    stopState === 'stopping'
                      ? 'bg-orange-600 hover:bg-red-600 text-white'
                      : 'bg-red-600 hover:bg-red-500 text-white'
                  }`}
                  aria-label={
                    stopState === 'stopping' ? 'Force stop' : 'Stop'
                  }
                  title={
                    stopState === 'stopping'
                      ? 'Click again to force stop'
                      : 'Stop execution'
                  }
                  data-testid="stop-btn"
                >
                  <Square className="w-4 h-4" />
                </button>
              )}

              <button
                onClick={() => void handleSubmit()}
                disabled={!input.trim() || disabled}
                className={`
                  p-2 rounded-lg transition-colors
                  ${
                    !input.trim() || disabled
                      ? 'bg-surface-active text-text-tertiary cursor-not-allowed'
                      : 'bg-primary-600 hover:bg-primary-500 text-white'
                  }
                `}
                aria-label={isRunning ? 'Queue message' : 'Send'}
                title={isRunning ? 'Message will be queued' : 'Send message'}
                data-testid="send-btn"
              >
                <Send className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Phase indicator */}
          {isRunning && (
            <div className="mt-2 flex items-center gap-2">
              <div className="w-2 h-2 bg-primary-500 rounded-full animate-pulse" />
              <span className="text-xs text-text-tertiary">
                {getPhaseLabel()}
              </span>
            </div>
          )}
        </div>
      </div>
    );
  },
);
