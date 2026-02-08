/**
 * AgenticChat Component
 *
 * Main chat interface for the agentic AI loop.
 * Reads messages from conversationStore (unified message model)
 * and renders them with ConversationMessageItem.
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import { useAgenticLoopWithStores, type UseAgenticLoopOptions } from '@/hooks/useAgenticLoop';
import { useAgentEventHandler } from '@/hooks/useAgentEventHandler';
import { useConversationStore } from '@/stores/conversationStore';
import type { ILLMClient, IToolExecutor, AgentContext, AgenticEngineConfig } from '@/agents/engine';
import { ConversationMessageItem } from './ConversationMessageItem';

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

// =============================================================================
// Component
// =============================================================================

export function AgenticChat({
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
}: AgenticChatProps) {
  // ===========================================================================
  // State
  // ===========================================================================

  const [input, setInput] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const isUserScrolledUpRef = useRef(false);

  // ===========================================================================
  // Conversation Store
  // ===========================================================================

  const messages = useConversationStore(
    (s) => s.activeConversation?.messages ?? []
  );
  const addUserMessage = useConversationStore((s) => s.addUserMessage);
  const addSystemMessage = useConversationStore((s) => s.addSystemMessage);

  // ===========================================================================
  // Agent Event Handler
  // ===========================================================================

  const { handleEvent } = useAgentEventHandler();

  // ===========================================================================
  // Agentic Loop Hook
  // ===========================================================================

  const {
    run,
    abort,
    approvePlan,
    rejectPlan,
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

  // ===========================================================================
  // Scroll Logic
  // ===========================================================================

  const scrollToBottom = useCallback(() => {
    if (isUserScrolledUpRef.current) return;
    if (messagesEndRef.current && typeof messagesEndRef.current.scrollIntoView === 'function') {
      messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, []);

  const handleScroll = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const threshold = 100;
    const isAtBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight < threshold;
    isUserScrolledUpRef.current = !isAtBottom;
  }, []);

  // ===========================================================================
  // Handlers
  // ===========================================================================

  const handleSubmit = useCallback(async () => {
    if (!input.trim() || isRunning || disabled) return;

    const userInput = input.trim();
    setInput('');

    // Add user message to conversation store
    addUserMessage(userInput);

    // Notify parent
    onSubmit?.(userInput);

    // Run the agentic loop
    if (isEnabled) {
      try {
        await run(userInput);
      } catch {
        // Error is handled by onError callback
      }
    }
  }, [input, isRunning, disabled, isEnabled, run, addUserMessage, onSubmit]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit]
  );

  const handleAbort = useCallback(() => {
    abort();
    addSystemMessage('Operation cancelled by user');
  }, [abort, addSystemMessage]);

  const handleApprove = useCallback(() => {
    approvePlan();
  }, [approvePlan]);

  const handleReject = useCallback(() => {
    rejectPlan('User rejected the plan');
    addSystemMessage('Plan rejected');
  }, [rejectPlan, addSystemMessage]);

  const handleRetry = useCallback(() => {
    void retry().catch(() => {
      // errors are surfaced via onError callback
    });
  }, [retry]);

  // ===========================================================================
  // Effects
  // ===========================================================================

  // Scroll to bottom on new messages
  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  // Focus input on mount
  useEffect(() => {
    if (!disabled) {
      inputRef.current?.focus();
    }
  }, [disabled]);

  // ===========================================================================
  // Render
  // ===========================================================================

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
          />
        ))}

        {/* Error Display (for errors not captured in parts) */}
        {error && (
          <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-lg">
            <p className="text-sm text-red-400">{error.message}</p>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input Area */}
      <div className="border-t border-border-subtle p-4">
        <div className="flex gap-2">
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            disabled={disabled || isRunning}
            className={`
              flex-1 px-4 py-2 rounded-lg
              bg-surface-elevated border border-border-subtle
              text-text-primary placeholder-text-tertiary
              focus:outline-none focus:ring-2 focus:ring-primary-500/50 focus:border-primary-500
              disabled:opacity-50 disabled:cursor-not-allowed
              transition-colors
            `}
          />

          {isRunning ? (
            <button
              onClick={handleAbort}
              className="px-4 py-2 bg-red-600 hover:bg-red-500 text-white rounded-lg transition-colors"
              aria-label="Cancel"
            >
              Cancel
            </button>
          ) : (
            <button
              onClick={handleSubmit}
              disabled={!input.trim() || disabled}
              className={`
                px-4 py-2 rounded-lg transition-colors
                ${!input.trim() || disabled
                  ? 'bg-surface-active text-text-tertiary cursor-not-allowed'
                  : 'bg-primary-600 hover:bg-primary-500 text-white'
                }
              `}
              aria-label="Send"
            >
              Send
            </button>
          )}
        </div>

        {/* Phase indicator */}
        {isRunning && (
          <div className="mt-2 flex items-center gap-2">
            <div className="w-2 h-2 bg-primary-500 rounded-full animate-pulse" />
            <span className="text-xs text-text-tertiary capitalize">
              {phase.replace(/_/g, ' ')}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
