/**
 * ChatMessage Component
 *
 * Renders individual chat messages with role-based styling.
 * Supports user messages, assistant messages, and embedded proposal cards.
 */

import { memo } from 'react';
import { type ChatMessage as ChatMessageType } from '@/stores/aiStore';
import { ProposalCard } from './ProposalCard';

// =============================================================================
// Types
// =============================================================================

export interface ChatMessageItemProps {
  /** The message to render */
  message: ChatMessageType;
}

// =============================================================================
// Component
// =============================================================================

export const ChatMessageItem = memo(function ChatMessageItem({
  message,
}: ChatMessageItemProps) {
  const isUser = message.role === 'user';
  const isSystem = message.role === 'system';

  if (isSystem) {
    return (
      <div className="text-center py-2">
        <span className="text-xs text-editor-text-secondary bg-editor-surface px-2 py-1 rounded">
          {message.content}
        </span>
      </div>
    );
  }

  return (
    <div
      data-testid="chat-message"
      className={`flex gap-2 ${isUser ? 'flex-row-reverse' : 'flex-row'}`}
    >
      {/* Avatar */}
      <div
        className={`w-7 h-7 rounded-full flex-shrink-0 flex items-center justify-center text-xs font-medium ${
          isUser
            ? 'bg-blue-600 text-white'
            : 'bg-purple-600 text-white'
        }`}
      >
        {isUser ? 'U' : 'AI'}
      </div>

      {/* Content */}
      <div
        className={`flex flex-col gap-2 max-w-[85%] ${
          isUser ? 'items-end' : 'items-start'
        }`}
      >
        {/* Message bubble */}
        <div
          className={`px-3 py-2 rounded-lg text-sm ${
            isUser
              ? 'bg-blue-600 text-white rounded-br-sm'
              : 'bg-editor-surface text-editor-text rounded-bl-sm'
          }`}
        >
          <p className="whitespace-pre-wrap break-words">{message.content}</p>
        </div>

        {/* Proposal card if present */}
        {message.proposal && (
          <ProposalCard proposal={message.proposal} />
        )}

        {/* Timestamp */}
        <span className="text-[10px] text-editor-text-secondary">
          {formatTimestamp(message.timestamp)}
        </span>
      </div>
    </div>
  );
});

// =============================================================================
// Helpers
// =============================================================================

function formatTimestamp(isoString: string): string {
  const date = new Date(isoString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;

  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;

  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
}
