/**
 * ChatMessageList
 *
 * Renders the scrollable list of conversation messages with auto-scroll
 * behavior. Extracted from AgenticChat to keep components under 200 lines.
 */

import { useCallback, useMemo, useRef, useEffect } from 'react';
import type { ConversationMessage } from '@/agents/engine/core/conversation';
import { ConversationMessageItem } from './ConversationMessageItem';
import { messageMatchesArtifactFocus, type AgentArtifactFocus } from './agentArtifactFocus';

// =============================================================================
// Types
// =============================================================================

export interface ChatMessageListProps {
  messages: readonly ConversationMessage[];
  conversationId?: string | null;
  error: Error | null;
  onApprove: () => void;
  onReject: (reason?: string) => void;
  onRetry: () => void;
  onToolAllow: () => void;
  onToolAllowAlways: () => void;
  onToolDeny: () => void;
  artifactFocus?: AgentArtifactFocus | null;
  className?: string;
}

function scrollContainerTo(
  container: HTMLDivElement,
  top: number,
  behavior: ScrollBehavior,
): void {
  const nextTop = Math.max(0, top);

  if (typeof container.scrollTo === 'function') {
    container.scrollTo({ top: nextTop, behavior });
    return;
  }

  container.scrollTop = nextTop;
}

function resolveOffsetWithinContainer(target: HTMLElement, container: HTMLElement): number {
  let offset = 0;
  let node: HTMLElement | null = target;

  while (node && node !== container) {
    offset += node.offsetTop;
    node = node.offsetParent instanceof HTMLElement ? node.offsetParent : null;
  }

  if (node === container) {
    return offset;
  }

  const targetRect = target.getBoundingClientRect();
  const containerRect = container.getBoundingClientRect();
  return container.scrollTop + targetRect.top - containerRect.top;
}

function scrollElementWithinContainer(
  container: HTMLDivElement,
  target: HTMLDivElement,
  behavior: ScrollBehavior,
): void {
  const targetTop = resolveOffsetWithinContainer(target, container);
  const centerOffset = Math.max(0, (container.clientHeight - target.clientHeight) / 2);
  scrollContainerTo(container, targetTop - centerOffset, behavior);
}

// =============================================================================
// Component
// =============================================================================

export function ChatMessageList({
  messages,
  conversationId = null,
  error,
  onApprove,
  onReject,
  onRetry,
  onToolAllow,
  onToolAllowAlways,
  onToolDeny,
  artifactFocus = null,
  className = '',
}: ChatMessageListProps) {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const isUserScrolledUpRef = useRef(false);
  const messageItemRefs = useRef<Record<string, HTMLDivElement | null>>({});

  const focusedMessageId = useMemo(() => {
    if (!artifactFocus) {
      return null;
    }

    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (messageMatchesArtifactFocus(message, artifactFocus)) {
        return message.id;
      }
    }

    return null;
  }, [artifactFocus, messages]);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'auto') => {
    if (isUserScrolledUpRef.current) return;
    const container = scrollContainerRef.current;
    if (!container) return;
    scrollContainerTo(container, container.scrollHeight, behavior);
  }, []);

  useEffect(() => {
    isUserScrolledUpRef.current = false;
    scrollToBottom('auto');
  }, [conversationId, scrollToBottom]);

  const handleScroll = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const threshold = 100;
    const isAtBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight < threshold;
    isUserScrolledUpRef.current = !isAtBottom;
  }, []);

  // Scroll to bottom on new messages
  useEffect(() => {
    if (artifactFocus) {
      return;
    }
    scrollToBottom('auto');
  }, [artifactFocus, messages, scrollToBottom]);

  useEffect(() => {
    if (!focusedMessageId) {
      return;
    }

    const target = messageItemRefs.current[focusedMessageId];
    const container = scrollContainerRef.current;
    if (target && container) {
      scrollElementWithinContainer(container, target, 'smooth');
    }
  }, [focusedMessageId]);

  return (
    <div
      ref={scrollContainerRef}
      onScroll={handleScroll}
      className={`min-h-0 min-w-0 flex-1 basis-0 space-y-3 overflow-y-auto overscroll-contain px-3 py-3 ${className}`}
    >
      {messages.map((message) => (
        <div
          key={message.id}
          ref={(node) => {
            messageItemRefs.current[message.id] = node;
          }}
          data-testid={`chat-message-wrapper-${message.id}`}
        >
          <ConversationMessageItem
            message={message}
            highlightArtifacts={message.id === focusedMessageId}
            onApprove={onApprove}
            onReject={onReject}
            onRetry={onRetry}
            onToolAllow={onToolAllow}
            onToolAllowAlways={onToolAllowAlways}
            onToolDeny={onToolDeny}
          />
        </div>
      ))}

      {/* Error Display */}
      {error && (
        <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-lg">
          <p className="text-sm text-red-400">{error.message}</p>
        </div>
      )}
    </div>
  );
}
