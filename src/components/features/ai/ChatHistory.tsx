/**
 * ChatHistory Component
 *
 * Displays the scrollable list of chat messages between user and AI assistant.
 * Handles auto-scrolling on new messages and lazy loading for performance.
 */

import { useRef, useEffect } from 'react';
import { useAIStore } from '@/stores/aiStore';
import { ChatMessageItem } from './ChatMessage';

// =============================================================================
// Constants
// =============================================================================

const SCROLL_THRESHOLD = 100; // pixels from bottom to trigger auto-scroll

// =============================================================================
// Types
// =============================================================================

export interface ChatHistoryProps {
  /** Optional CSS class name */
  className?: string;
}

// =============================================================================
// Component
// =============================================================================

export function ChatHistory({ className = '' }: ChatHistoryProps) {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const shouldAutoScrollRef = useRef(true);

  // Get chat messages from store
  const chatMessages = useAIStore((state) => state.chatMessages);
  const isGenerating = useAIStore((state) => state.isGenerating);

  // Handle scroll to detect if user is near bottom
  const handleScroll = () => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const { scrollTop, scrollHeight, clientHeight } = container;
    const distanceFromBottom = scrollHeight - scrollTop - clientHeight;

    shouldAutoScrollRef.current = distanceFromBottom < SCROLL_THRESHOLD;
  };

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    if (shouldAutoScrollRef.current && scrollContainerRef.current) {
      scrollContainerRef.current.scrollTop = scrollContainerRef.current.scrollHeight;
    }
  }, [chatMessages.length]);

  return (
    <div
      ref={scrollContainerRef}
      data-testid="chat-history"
      className={`flex-1 overflow-y-auto overflow-x-hidden ${className}`}
      onScroll={handleScroll}
    >
      {chatMessages.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="flex flex-col gap-3 p-3">
          {chatMessages.map((message) => (
            <ChatMessageItem key={message.id} message={message} />
          ))}
          {isGenerating && <TypingIndicator />}
        </div>
      )}
    </div>
  );
}

// =============================================================================
// Sub-Components
// =============================================================================

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center h-full px-4 py-8 text-center">
      <div className="w-12 h-12 rounded-full bg-editor-surface flex items-center justify-center mb-3">
        <svg
          className="w-6 h-6 text-editor-text-secondary"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
          />
        </svg>
      </div>
      <h3 className="text-sm font-medium text-editor-text mb-1">
        Start a conversation
      </h3>
      <p className="text-xs text-editor-text-secondary max-w-[200px]">
        Ask me to edit your video, add effects, or help with your project.
      </p>
    </div>
  );
}

function TypingIndicator() {
  return (
    <div className="flex items-center gap-2 px-3 py-2">
      <div className="flex gap-1">
        <span className="w-2 h-2 bg-editor-text-secondary rounded-full animate-bounce [animation-delay:-0.3s]" />
        <span className="w-2 h-2 bg-editor-text-secondary rounded-full animate-bounce [animation-delay:-0.15s]" />
        <span className="w-2 h-2 bg-editor-text-secondary rounded-full animate-bounce" />
      </div>
      <span className="text-xs text-editor-text-secondary">AI is thinking...</span>
    </div>
  );
}
