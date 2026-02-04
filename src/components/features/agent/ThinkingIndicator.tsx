/**
 * ThinkingIndicator Component
 *
 * Displays the AI's thinking process during the Think phase.
 * Shows understanding, requirements, uncertainties, and approach.
 */

import { useMemo } from 'react';
import type { Thought } from '@/agents/engine';

// =============================================================================
// Types
// =============================================================================

export interface ThinkingIndicatorProps {
  /** Whether the AI is currently thinking */
  isThinking: boolean;
  /** The thought result (if available) */
  thought: Thought | null;
  /** Show in collapsed mode */
  collapsed?: boolean;
  /** Optional className */
  className?: string;
}

// =============================================================================
// Component
// =============================================================================

export function ThinkingIndicator({
  isThinking,
  thought,
  collapsed = false,
  className = '',
}: ThinkingIndicatorProps) {
  // ===========================================================================
  // Derived State
  // ===========================================================================

  const hasUncertainties = useMemo(
    () => thought?.uncertainties && thought.uncertainties.length > 0,
    [thought]
  );

  const needsClarification = thought?.needsMoreInfo && thought?.clarificationQuestion;

  // ===========================================================================
  // Loading State
  // ===========================================================================

  if (isThinking && !thought) {
    return (
      <div
        data-testid="thinking-indicator"
        className={`p-4 bg-blue-500/10 border border-blue-500/20 rounded-lg ${className}`}
      >
        <div className="flex items-center gap-3">
          <div
            data-testid="thinking-spinner"
            className="w-5 h-5 border-2 border-blue-400/30 border-t-blue-400 rounded-full animate-spin"
          />
          <span className="text-sm text-blue-400 font-medium">
            Analyzing your request...
          </span>
        </div>
      </div>
    );
  }

  // ===========================================================================
  // No Thought
  // ===========================================================================

  if (!thought) {
    return (
      <div data-testid="thinking-indicator" className={className} />
    );
  }

  // ===========================================================================
  // Collapsed Mode
  // ===========================================================================

  if (collapsed) {
    return (
      <div
        data-testid="thinking-indicator"
        className={`p-3 bg-surface-elevated border border-border-subtle rounded-lg ${className}`}
      >
        <div className="flex items-start gap-2">
          <span className="text-blue-400 text-sm">💭</span>
          <p className="text-sm text-text-secondary">{thought.understanding}</p>
        </div>
      </div>
    );
  }

  // ===========================================================================
  // Full Mode
  // ===========================================================================

  return (
    <div
      data-testid="thinking-indicator"
      className={`bg-surface-elevated border border-border-subtle rounded-lg overflow-hidden ${className}`}
    >
      {/* Header */}
      <div className="px-4 py-3 border-b border-border-subtle bg-blue-500/5">
        <div className="flex items-center gap-2">
          <span className="text-blue-400">💭</span>
          <span className="text-sm font-medium text-text-primary">
            Understanding
          </span>
          {isThinking && (
            <div className="w-4 h-4 border-2 border-blue-400/30 border-t-blue-400 rounded-full animate-spin ml-auto" />
          )}
        </div>
      </div>

      {/* Content */}
      <div className="p-4 space-y-4">
        {/* Understanding */}
        <p className="text-sm text-text-primary">{thought.understanding}</p>

        {/* Clarification Question */}
        {needsClarification && (
          <div className="p-3 bg-yellow-500/10 border border-yellow-500/20 rounded-lg">
            <div className="flex items-start gap-2">
              <span className="text-yellow-400">❓</span>
              <p className="text-sm text-yellow-300">
                {thought.clarificationQuestion}
              </p>
            </div>
          </div>
        )}

        {/* Requirements */}
        {thought.requirements.length > 0 && (
          <div>
            <h4 className="text-xs font-medium text-text-tertiary uppercase tracking-wider mb-2">
              Requirements
            </h4>
            <div className="flex flex-wrap gap-2">
              {thought.requirements.map((req, index) => (
                <span
                  key={index}
                  className="px-2 py-1 text-xs bg-surface-active text-text-secondary rounded"
                >
                  {req}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Uncertainties */}
        {hasUncertainties && (
          <div>
            <h4 className="text-xs font-medium text-yellow-400/70 uppercase tracking-wider mb-2">
              Uncertainties
            </h4>
            <ul className="space-y-1">
              {thought.uncertainties.map((uncertainty, index) => (
                <li
                  key={index}
                  className="text-sm text-yellow-400/80 flex items-start gap-2"
                >
                  <span className="text-yellow-400/50">•</span>
                  {uncertainty}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Approach */}
        <div>
          <h4 className="text-xs font-medium text-text-tertiary uppercase tracking-wider mb-2">
            Approach
          </h4>
          <p className="text-sm text-text-secondary">{thought.approach}</p>
        </div>
      </div>
    </div>
  );
}
