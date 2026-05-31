/**
 * ToolCallPartRenderer
 *
 * Renders tool invocation with name, args, and status.
 * Collapsed by default; expandable to show arguments.
 */

import { useState } from 'react';
import { CheckCircle2, Circle, LoaderCircle, XCircle } from 'lucide-react';
import type { ToolCallPart } from '@/agents/engine/core/conversation';

interface ToolCallPartRendererProps {
  part: ToolCallPart;
  className?: string;
}

const statusConfig: Record<
  ToolCallPart['status'],
  { label: string; color: string; icon: typeof Circle }
> = {
  pending: { label: 'Pending', color: 'text-text-tertiary', icon: Circle },
  running: { label: 'Running', color: 'text-primary-400', icon: LoaderCircle },
  completed: { label: 'Done', color: 'text-green-400', icon: CheckCircle2 },
  failed: { label: 'Issue', color: 'text-yellow-400', icon: XCircle },
};

export function ToolCallPartRenderer({ part, className = '' }: ToolCallPartRendererProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const status = statusConfig[part.status];
  const StatusIcon = status.icon;

  return (
    <div
      className={`border border-border-subtle rounded-lg overflow-hidden ${className}`}
      data-testid="tool-call-part"
    >
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-surface-elevated transition-colors"
        aria-expanded={isExpanded}
      >
        <span className={`inline-flex shrink-0 items-center gap-1 text-[11px] ${status.color}`}>
          <StatusIcon
            className={`h-3.5 w-3.5 ${part.status === 'running' ? 'animate-spin' : ''}`}
            aria-hidden="true"
          />
          {status.label}
        </span>
        <span className="text-xs font-mono text-text-secondary">{part.tool}</span>
        <span className="text-xs text-text-tertiary truncate flex-1">{part.description}</span>
        {part.status === 'running' && (
          <span className="w-2 h-2 bg-primary-500 rounded-full animate-pulse" />
        )}
      </button>

      {isExpanded && (
        <div className="px-3 pb-2 border-t border-border-subtle">
          <pre className="text-xs text-text-tertiary mt-1.5 overflow-x-auto whitespace-pre-wrap font-mono">
            {JSON.stringify(part.args, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}
