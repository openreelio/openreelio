/**
 * ThinkingPartRenderer
 *
 * Renders the Think phase output as a collapsible section
 * showing understanding, approach, requirements, and uncertainties.
 */

import { useState } from 'react';
import type { ThinkingPart } from '@/agents/engine/core/conversation';

interface ThinkingPartRendererProps {
  part: ThinkingPart;
  className?: string;
}

export function ThinkingPartRenderer({ part, className = '' }: ThinkingPartRendererProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const { thought } = part;

  return (
    <div
      className={`border border-border-subtle rounded-lg overflow-hidden ${className}`}
      data-testid="thinking-part"
    >
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-surface-elevated transition-colors"
        aria-expanded={isExpanded}
      >
        <span className="text-xs text-text-tertiary">{isExpanded ? '\u25BC' : '\u25B6'}</span>
        <span className="text-xs font-medium text-text-secondary">Thinking</span>
        <span className="text-xs text-text-tertiary ml-auto">
          {thought.requirements.length} requirements
        </span>
      </button>

      {isExpanded && (
        <div className="px-3 pb-3 space-y-2 border-t border-border-subtle">
          <div className="mt-2">
            <div className="text-xs font-medium text-text-tertiary mb-1">Understanding</div>
            <p className="text-sm text-text-primary">{thought.understanding}</p>
          </div>

          <div>
            <div className="text-xs font-medium text-text-tertiary mb-1">Approach</div>
            <p className="text-sm text-text-primary">{thought.approach}</p>
          </div>

          {thought.needsMoreInfo && thought.clarificationQuestion && (
            <div className="p-2 rounded-md bg-yellow-500/10 border border-yellow-500/20">
              <div className="text-xs font-medium text-yellow-300 mb-1">Clarification Needed</div>
              <p className="text-sm text-yellow-200">{thought.clarificationQuestion}</p>
            </div>
          )}

          {thought.requirements.length > 0 && (
            <div>
              <div className="text-xs font-medium text-text-tertiary mb-1">Requirements</div>
              <ul className="space-y-0.5">
                {thought.requirements.map((req, i) => (
                  <li key={i} className="text-sm text-text-secondary flex gap-2">
                    <span className="text-text-tertiary">-</span>
                    {req}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {thought.uncertainties.length > 0 && (
            <div>
              <div className="text-xs font-medium text-yellow-400 mb-1">Uncertainties</div>
              <ul className="space-y-0.5">
                {thought.uncertainties.map((unc, i) => (
                  <li key={i} className="text-sm text-yellow-300 flex gap-2">
                    <span>?</span>
                    {unc}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
