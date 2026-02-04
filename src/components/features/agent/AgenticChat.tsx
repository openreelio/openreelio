/**
 * AgenticChat Component
 *
 * Main chat interface for the agentic AI loop.
 * Integrates with useAgenticLoop to provide a complete chat experience.
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import { useAgenticLoop, type UseAgenticLoopOptions } from '@/hooks/useAgenticLoop';
import type { ILLMClient, IToolExecutor, AgentContext, AgenticEngineConfig } from '@/agents/engine';
import { ThinkingIndicator } from './ThinkingIndicator';
import { PlanViewer } from './PlanViewer';
import { ActionFeed } from './ActionFeed';

// =============================================================================
// Types
// =============================================================================

interface ChatMessage {
  id: string;
  type: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
}

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
  /** Show thinking indicator */
  showThinking?: boolean;
  /** Show plan viewer */
  showPlan?: boolean;
  /** Show action feed */
  showActions?: boolean;
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
  showThinking = true,
  showPlan = true,
  showActions = true,
  className = '',
}: AgenticChatProps) {
  // ===========================================================================
  // State
  // ===========================================================================

  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // ===========================================================================
  // Agentic Loop Hook
  // ===========================================================================

  const {
    run,
    abort,
    approvePlan,
    rejectPlan,
    phase,
    isRunning,
    events,
    error,
    thought,
    plan,
    isEnabled,
  } = useAgenticLoop({
    llmClient,
    toolExecutor,
    config,
    context,
    onComplete: (result) => {
      // Add assistant message on completion
      if (result.summary) {
        addMessage('assistant', result.summary.finalState);
      }
      onComplete?.(result);
    },
    onError: (err) => {
      addMessage('system', `Error: ${err.message}`);
      onError?.(err);
    },
    onApprovalRequired: () => {
      // Approval is handled through the PlanViewer component
    },
  });

  // ===========================================================================
  // Helpers
  // ===========================================================================

  const addMessage = useCallback((type: ChatMessage['type'], content: string) => {
    const message: ChatMessage = {
      id: crypto.randomUUID(),
      type,
      content,
      timestamp: Date.now(),
    };
    setMessages((prev) => [...prev, message]);
  }, []);

  const scrollToBottom = useCallback(() => {
    // scrollIntoView may not exist in test environments (jsdom)
    if (messagesEndRef.current && typeof messagesEndRef.current.scrollIntoView === 'function') {
      messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, []);

  // ===========================================================================
  // Handlers
  // ===========================================================================

  const handleSubmit = useCallback(async () => {
    if (!input.trim() || isRunning || disabled) return;

    const userInput = input.trim();
    setInput('');

    // Add user message
    addMessage('user', userInput);

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
  }, [input, isRunning, disabled, isEnabled, run, addMessage, onSubmit]);

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
    addMessage('system', 'Operation cancelled by user');
  }, [abort, addMessage]);

  const handleApprove = useCallback(() => {
    approvePlan();
  }, [approvePlan]);

  const handleReject = useCallback(() => {
    rejectPlan('User rejected the plan');
    addMessage('system', 'Plan rejected');
  }, [rejectPlan, addMessage]);

  // ===========================================================================
  // Effects
  // ===========================================================================

  // Scroll to bottom on new messages or events
  useEffect(() => {
    scrollToBottom();
  }, [messages, events, scrollToBottom]);

  // Focus input on mount
  useEffect(() => {
    if (!disabled) {
      inputRef.current?.focus();
    }
  }, [disabled]);

  // ===========================================================================
  // Render
  // ===========================================================================

  const isThinking = phase === 'thinking';
  const isPlanning = phase === 'planning';
  const isAwaitingApproval = phase === 'awaiting_approval';
  const isExecuting = phase === 'executing';

  return (
    <div
      data-testid="agentic-chat"
      className={`flex flex-col h-full bg-surface-base ${className}`}
    >
      {/* Messages Area */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.map((message) => (
          <MessageBubble key={message.id} message={message} />
        ))}

        {/* Thinking Indicator */}
        {showThinking && (isThinking || isPlanning) && (
          <ThinkingIndicator
            isThinking={isThinking}
            thought={thought}
            className="my-2"
          />
        )}

        {/* Plan Viewer */}
        {showPlan && plan && (
          <PlanViewer
            plan={plan}
            isAwaitingApproval={isAwaitingApproval}
            onApprove={handleApprove}
            onReject={handleReject}
            className="my-2"
          />
        )}

        {/* Action Feed */}
        {showActions && events.length > 0 && (isExecuting || phase === 'observing') && (
          <ActionFeed
            events={events}
            filter="tools"
            autoScroll={true}
            compact={true}
            className="my-2 max-h-48"
          />
        )}

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

// =============================================================================
// Sub-Components
// =============================================================================

interface MessageBubbleProps {
  message: ChatMessage;
}

function MessageBubble({ message }: MessageBubbleProps) {
  const isUser = message.type === 'user';
  const isSystem = message.type === 'system';

  return (
    <div
      className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}
    >
      <div
        className={`
          max-w-[80%] px-4 py-2 rounded-lg
          ${isUser
            ? 'bg-primary-600 text-white'
            : isSystem
            ? 'bg-yellow-500/10 text-yellow-400 border border-yellow-500/20'
            : 'bg-surface-elevated text-text-primary border border-border-subtle'
          }
        `}
      >
        <p className="text-sm whitespace-pre-wrap">{message.content}</p>
        <span className="text-xs opacity-60 mt-1 block">
          {new Date(message.timestamp).toLocaleTimeString()}
        </span>
      </div>
    </div>
  );
}
