/**
 * ConversationMessageItem
 *
 * Renders a single ConversationMessage by iterating its typed parts
 * and dispatching to the appropriate part renderer.
 *
 * - User messages: right-aligned, primary color
 * - Assistant messages: left-aligned, surface color, multi-part layout
 * - System messages: centered, muted
 */

import type { ConversationMessage, MessagePart } from '@/agents/engine/core/conversation';
import { TextPartRenderer } from './parts/TextPartRenderer';
import { ThinkingPartRenderer } from './parts/ThinkingPartRenderer';
import { PlanPartRenderer } from './parts/PlanPartRenderer';
import { ToolCallPartRenderer } from './parts/ToolCallPartRenderer';
import { ToolResultPartRenderer } from './parts/ToolResultPartRenderer';
import { ErrorPartRenderer } from './parts/ErrorPartRenderer';
import { ApprovalPartRenderer } from './parts/ApprovalPartRenderer';
import { ToolApprovalPartRenderer } from './parts/ToolApprovalPartRenderer';

// =============================================================================
// Types
// =============================================================================

interface ConversationMessageItemProps {
  message: ConversationMessage;
  onApprove?: () => void;
  onReject?: (reason?: string) => void;
  onRetry?: () => void;
  onToolAllow?: () => void;
  onToolAllowAlways?: () => void;
  onToolDeny?: () => void;
  className?: string;
}

// =============================================================================
// Part Renderer Dispatch
// =============================================================================

interface PartCallbacks {
  onApprove?: () => void;
  onReject?: (reason?: string) => void;
  onRetry?: () => void;
  onToolAllow?: () => void;
  onToolAllowAlways?: () => void;
  onToolDeny?: () => void;
}

function renderPart(
  part: MessagePart,
  index: number,
  callbacks: PartCallbacks,
): React.ReactNode {
  const key = `${part.type}-${index}`;

  switch (part.type) {
    case 'text':
      return <TextPartRenderer key={key} part={part} />;
    case 'thinking':
      return <ThinkingPartRenderer key={key} part={part} />;
    case 'plan':
      return (
        <PlanPartRenderer
          key={key}
          part={part}
          onApprove={callbacks.onApprove}
          onReject={callbacks.onReject}
        />
      );
    case 'tool_call':
      return <ToolCallPartRenderer key={key} part={part} />;
    case 'tool_result':
      return <ToolResultPartRenderer key={key} part={part} />;
    case 'error':
      return <ErrorPartRenderer key={key} part={part} onRetry={callbacks.onRetry} />;
    case 'approval':
      return (
        <ApprovalPartRenderer
          key={key}
          part={part}
          onApprove={callbacks.onApprove}
          onReject={callbacks.onReject}
        />
      );
    case 'tool_approval':
      return (
        <ToolApprovalPartRenderer
          key={key}
          part={part}
          onAllow={callbacks.onToolAllow}
          onAllowAlways={callbacks.onToolAllowAlways}
          onDeny={callbacks.onToolDeny}
        />
      );
    default:
      return null;
  }
}

// =============================================================================
// Component
// =============================================================================

export function ConversationMessageItem({
  message,
  onApprove,
  onReject,
  onRetry,
  onToolAllow,
  onToolAllowAlways,
  onToolDeny,
  className = '',
}: ConversationMessageItemProps) {
  const isUser = message.role === 'user';
  const isSystem = message.role === 'system';

  // User messages: right-aligned bubble
  if (isUser) {
    const textContent = message.parts
      .filter((p) => p.type === 'text')
      .map((p) => (p as { content: string }).content)
      .join('\n');

    return (
      <div
        className={`flex justify-end ${className}`}
        data-testid="conversation-message-user"
      >
        <div className="max-w-[80%] px-4 py-2 rounded-lg bg-primary-600 text-white">
          <p className="text-sm whitespace-pre-wrap">{textContent}</p>
          <span className="text-xs opacity-60 mt-1 block">
            {new Date(message.timestamp).toLocaleTimeString()}
          </span>
        </div>
      </div>
    );
  }

  // System messages: centered, muted
  if (isSystem) {
    const textContent = message.parts
      .filter((p) => p.type === 'text')
      .map((p) => (p as { content: string }).content)
      .join('\n');

    return (
      <div
        className={`flex justify-center ${className}`}
        data-testid="conversation-message-system"
      >
        <div className="max-w-[80%] px-4 py-2 rounded-lg bg-yellow-500/10 text-yellow-400 border border-yellow-500/20">
          <p className="text-sm whitespace-pre-wrap">{textContent}</p>
        </div>
      </div>
    );
  }

  // Assistant messages: left-aligned, multi-part layout
  return (
    <div
      className={`flex justify-start ${className}`}
      data-testid="conversation-message-assistant"
    >
      <div className="max-w-[85%] space-y-2">
        {message.parts.map((part, i) =>
          renderPart(part, i, {
            onApprove,
            onReject,
            onRetry,
            onToolAllow,
            onToolAllowAlways,
            onToolDeny,
          })
        )}
        <span className="text-xs text-text-tertiary block">
          {new Date(message.timestamp).toLocaleTimeString()}
        </span>
      </div>
    </div>
  );
}
