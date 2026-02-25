/**
 * ReasoningPartRenderer
 *
 * Renders LLM extended thinking / reasoning content.
 * Displayed as a collapsible block with dim styling.
 */

import { useState } from 'react';
import type { ReasoningPart } from '@/agents/engine/core/conversation';

interface ReasoningPartRendererProps {
  part: ReasoningPart;
  className?: string;
}

export function ReasoningPartRenderer({ part, className = '' }: ReasoningPartRendererProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  const preview = part.content.length > 120
    ? part.content.slice(0, 120) + '...'
    : part.content;

  return (
    <div
      className={`border border-border-subtle rounded-lg overflow-hidden bg-surface-base/50 ${className}`}
      data-testid="reasoning-part"
    >
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-surface-elevated transition-colors"
        aria-expanded={isExpanded}
      >
        <span className="text-xs text-text-tertiary">
          {isExpanded ? '\u25BC' : '\u25B6'}
        </span>
        <span className="text-xs font-medium text-text-tertiary">Reasoning</span>
        {!isExpanded && (
          <span className="text-xs text-text-tertiary/60 truncate flex-1">
            {preview}
          </span>
        )}
      </button>

      {isExpanded && (
        <div className="px-3 pb-2 border-t border-border-subtle">
          <p className="text-xs text-text-tertiary mt-1.5 whitespace-pre-wrap leading-relaxed">
            {part.content}
          </p>
        </div>
      )}
    </div>
  );
}
