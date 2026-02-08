/**
 * ToolCallPartRenderer
 *
 * Renders tool invocation with name, args, and status.
 * Collapsed by default; expandable to show arguments.
 */

import { useState } from 'react';
import type { ToolCallPart } from '@/agents/engine/core/conversation';

interface ToolCallPartRendererProps {
  part: ToolCallPart;
  className?: string;
}

const statusIcons: Record<string, string> = {
  pending: '\u23F3',    // hourglass
  running: '\u25B6',    // play
  completed: '\u2705',  // check
  failed: '\u274C',     // cross
};

const statusColors: Record<string, string> = {
  pending: 'text-text-tertiary',
  running: 'text-primary-400',
  completed: 'text-green-400',
  failed: 'text-red-400',
};

export function ToolCallPartRenderer({ part, className = '' }: ToolCallPartRendererProps) {
  const [isExpanded, setIsExpanded] = useState(false);

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
        <span className={`text-xs ${statusColors[part.status]}`}>
          {statusIcons[part.status]}
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
