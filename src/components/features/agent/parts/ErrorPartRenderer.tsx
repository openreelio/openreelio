/**
 * ErrorPartRenderer
 *
 * Renders error messages with optional retry button.
 */

import type { ErrorPart } from '@/agents/engine/core/conversation';

interface ErrorPartRendererProps {
  part: ErrorPart;
  onRetry?: () => void;
  className?: string;
}

export function ErrorPartRenderer({ part, onRetry, className = '' }: ErrorPartRendererProps) {
  return (
    <div
      className={`p-3 bg-red-500/10 border border-red-500/20 rounded-lg ${className}`}
      data-testid="error-part"
    >
      <div className="flex items-start gap-2">
        <span className="text-red-400 text-sm mt-0.5">\u26A0</span>
        <div className="flex-1 min-w-0">
          <p className="text-sm text-red-400">{part.message}</p>
          <div className="flex items-center gap-2 mt-1">
            <span className="text-xs text-red-400/60 font-mono">{part.code}</span>
            <span className="text-xs text-red-400/60">in {part.phase}</span>
          </div>
        </div>
      </div>

      {part.recoverable && onRetry && (
        <button
          onClick={onRetry}
          className="mt-2 px-3 py-1 text-xs bg-red-600 hover:bg-red-500 text-white rounded transition-colors"
          data-testid="error-retry-btn"
        >
          Retry
        </button>
      )}
    </div>
  );
}
