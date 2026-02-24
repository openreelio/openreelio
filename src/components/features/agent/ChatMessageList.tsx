/**
 * ChatMessageList
 *
 * Renders the scrollable list of conversation messages with auto-scroll
 * behavior. Extracted from AgenticChat to keep components under 200 lines.
 */

import { useCallback, useRef, useEffect } from 'react';
import type { ConversationMessage } from '@/agents/engine/core/conversation';
import { ConversationMessageItem } from './ConversationMessageItem';

// =============================================================================
// Types
// =============================================================================

export interface ChatMessageListProps {
  messages: readonly ConversationMessage[];
  error: Error | null;
  onApprove: () => void;
  onReject: (reason?: string) => void;
  onRetry: () => void;
  onToolAllow: () => void;
  onToolAllowAlways: () => void;
  onToolDeny: () => void;
  className?: string;
}

// =============================================================================
// Component
// =============================================================================

export function ChatMessageList({
  messages,
  error,
  onApprove,
  onReject,
  onRetry,
  onToolAllow,
  onToolAllowAlways,
  onToolDeny,
  className = '',
}: ChatMessageListProps) {
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const isUserScrolledUpRef = useRef(false);

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

  // Scroll to bottom on new messages
  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  return (
    <div
      ref={scrollContainerRef}
      onScroll={handleScroll}
      className={`flex-1 overflow-y-auto p-4 space-y-4 ${className}`}
    >
      {messages.map((message) => (
        <ConversationMessageItem
          key={message.id}
          message={message}
          onApprove={onApprove}
          onReject={onReject}
          onRetry={onRetry}
          onToolAllow={onToolAllow}
          onToolAllowAlways={onToolAllowAlways}
          onToolDeny={onToolDeny}
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
  );
}
