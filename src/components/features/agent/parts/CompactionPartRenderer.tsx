/**
 * CompactionPartRenderer
 *
 * Renders a notice when the conversation context was summarized.
 * Shows "Context summarized" with expandable summary.
 */

import { useState } from 'react';
import type { CompactionPart } from '@/agents/engine/core/conversation';

interface CompactionPartRendererProps {
  part: CompactionPart;
  className?: string;
}

export function CompactionPartRenderer({ part, className = '' }: CompactionPartRendererProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  return (
    <div
      className={`border border-blue-500/20 rounded-lg overflow-hidden bg-blue-500/5 ${className}`}
      data-testid="compaction-part"
    >
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-blue-500/10 transition-colors"
        aria-expanded={isExpanded}
      >
        <span className="text-xs text-blue-400">
          {isExpanded ? '\u25BC' : '\u25B6'}
        </span>
        <span className="text-xs font-medium text-blue-400">
          Context summarized
        </span>
        <span className="text-xs text-blue-400/60">
          {part.auto ? '(auto)' : '(manual)'}
        </span>
      </button>

      {isExpanded && (
        <div className="px-3 pb-2 border-t border-blue-500/20">
          <p className="text-xs text-text-secondary mt-1.5 whitespace-pre-wrap leading-relaxed">
            {part.summary}
          </p>
        </div>
      )}
    </div>
  );
}
