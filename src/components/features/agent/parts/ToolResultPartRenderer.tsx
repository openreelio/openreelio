/**
 * ToolResultPartRenderer
 *
 * Renders tool execution results with success/failure indicator,
 * duration, and expandable data view.
 */

import { useState } from 'react';
import type { ToolResultPart } from '@/agents/engine/core/conversation';

interface ToolResultPartRendererProps {
  part: ToolResultPart;
  className?: string;
}

export function ToolResultPartRenderer({ part, className = '' }: ToolResultPartRendererProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const hasData = part.data !== undefined || part.error !== undefined;

  return (
    <div
      className={`rounded-lg overflow-hidden ${className}`}
      data-testid="tool-result-part"
    >
      <button
        onClick={hasData ? () => setIsExpanded(!isExpanded) : undefined}
        className={`w-full flex items-center gap-2 px-3 py-1.5 text-left ${
          hasData ? 'hover:bg-surface-elevated cursor-pointer' : 'cursor-default'
        } transition-colors`}
        aria-expanded={isExpanded}
      >
        <span className={`text-xs ${part.success ? 'text-green-400' : 'text-red-400'}`}>
          {part.success ? '\u2713' : '\u2717'}
        </span>
        <span className="text-xs font-mono text-text-secondary">{part.tool}</span>
        <span className="text-xs text-text-tertiary ml-auto">
          {part.duration}ms
        </span>
      </button>

      {isExpanded && (
        <div className="px-3 pb-2">
          {part.error && (
            <p className="text-xs text-red-400 mt-1">{part.error}</p>
          )}
          {part.data !== undefined && (
            <pre className="text-xs text-text-tertiary mt-1 overflow-x-auto whitespace-pre-wrap font-mono max-h-32 overflow-y-auto">
              {JSON.stringify(part.data, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
