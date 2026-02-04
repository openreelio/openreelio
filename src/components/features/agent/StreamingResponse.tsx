/**
 * StreamingResponse Component
 *
 * Displays AI agent streaming responses with real-time updates.
 * Shows typing indicator, content, and completion status.
 */

import { useEffect, useRef, useMemo } from 'react';

// =============================================================================
// Types
// =============================================================================

export interface StreamingResponseProps {
  /** Current streaming content */
  content: string;
  /** Whether actively streaming */
  isStreaming: boolean;
  /** Whether stream is complete */
  isComplete: boolean;
  /** Whether stream was aborted */
  isAborted: boolean;
  /** Error message if any */
  error?: string | null;
  /** Number of chunks received */
  chunkCount?: number;
  /** Duration in milliseconds */
  duration?: number;
  /** Optional callback when abort is clicked */
  onAbort?: () => void;
  /** Optional callback when retry is clicked */
  onRetry?: () => void;
  /** Whether to show statistics */
  showStats?: boolean;
  /** Maximum height before scrolling */
  maxHeight?: number;
  /** Custom class name */
  className?: string;
}

// =============================================================================
// Sub-Components
// =============================================================================

function TypingIndicator() {
  return (
    <span className="inline-flex items-center gap-1 ml-1">
      <span className="w-1.5 h-1.5 bg-primary-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
      <span className="w-1.5 h-1.5 bg-primary-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
      <span className="w-1.5 h-1.5 bg-primary-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
    </span>
  );
}

interface StatusBadgeProps {
  status: 'streaming' | 'complete' | 'aborted' | 'error';
}

function StatusBadge({ status }: StatusBadgeProps) {
  const config = useMemo(() => {
    switch (status) {
      case 'streaming':
        return { label: 'Generating', color: 'bg-primary-500/20 text-primary-400' };
      case 'complete':
        return { label: 'Complete', color: 'bg-green-500/20 text-green-400' };
      case 'aborted':
        return { label: 'Aborted', color: 'bg-yellow-500/20 text-yellow-400' };
      case 'error':
        return { label: 'Error', color: 'bg-red-500/20 text-red-400' };
    }
  }, [status]);

  return (
    <span className={`px-2 py-0.5 text-xs font-medium rounded ${config.color}`}>
      {config.label}
    </span>
  );
}

// =============================================================================
// Component
// =============================================================================

export function StreamingResponse({
  content,
  isStreaming,
  isComplete,
  isAborted,
  error,
  chunkCount,
  duration,
  onAbort,
  onRetry,
  showStats = false,
  maxHeight = 400,
  className = '',
}: StreamingResponseProps) {
  const contentRef = useRef<HTMLDivElement>(null);

  // ===========================================================================
  // Derived State
  // ===========================================================================

  const status = useMemo(() => {
    if (error) return 'error';
    if (isAborted) return 'aborted';
    if (isComplete) return 'complete';
    if (isStreaming) return 'streaming';
    return 'complete';
  }, [error, isAborted, isComplete, isStreaming]);

  const formattedDuration = useMemo(() => {
    if (!duration) return null;
    if (duration < 1000) return `${duration}ms`;
    return `${(duration / 1000).toFixed(1)}s`;
  }, [duration]);

  // ===========================================================================
  // Effects
  // ===========================================================================

  // Auto-scroll to bottom while streaming
  useEffect(() => {
    if (isStreaming && contentRef.current) {
      contentRef.current.scrollTop = contentRef.current.scrollHeight;
    }
  }, [content, isStreaming]);

  // ===========================================================================
  // Render
  // ===========================================================================

  return (
    <div
      data-testid="streaming-response"
      className={`bg-surface-elevated rounded-lg border border-border-subtle overflow-hidden ${className}`}
    >
      {/* Header */}
      <div className="px-4 py-2 border-b border-border-subtle flex items-center justify-between bg-surface-active">
        <div className="flex items-center gap-2">
          <StatusBadge status={status} />
          {showStats && formattedDuration && (
            <span className="text-xs text-text-tertiary">
              {formattedDuration}
            </span>
          )}
          {showStats && chunkCount !== undefined && (
            <span className="text-xs text-text-tertiary">
              {chunkCount} chunks
            </span>
          )}
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2">
          {isStreaming && onAbort && (
            <button
              onClick={onAbort}
              className="text-xs text-text-tertiary hover:text-text-secondary transition-colors"
            >
              Stop
            </button>
          )}
          {(error || isAborted) && onRetry && (
            <button
              onClick={onRetry}
              className="text-xs text-primary-400 hover:text-primary-300 transition-colors"
            >
              Retry
            </button>
          )}
        </div>
      </div>

      {/* Content */}
      <div
        ref={contentRef}
        className="p-4 overflow-y-auto"
        style={{ maxHeight }}
      >
        {/* Empty state */}
        {!content && !isStreaming && !error && (
          <p className="text-text-tertiary text-sm italic">
            No response yet...
          </p>
        )}

        {/* Streaming/Content */}
        {(content || isStreaming) && (
          <div className="prose prose-invert prose-sm max-w-none">
            <p className="text-text-primary whitespace-pre-wrap break-words">
              {content}
              {isStreaming && <TypingIndicator />}
            </p>
          </div>
        )}

        {/* Error Message */}
        {error && (
          <div className="mt-3 p-3 bg-red-500/10 border border-red-500/30 rounded">
            <p className="text-sm text-red-400">{error}</p>
          </div>
        )}

        {/* Aborted Message */}
        {isAborted && !error && (
          <div className="mt-3 p-3 bg-yellow-500/10 border border-yellow-500/30 rounded">
            <p className="text-sm text-yellow-400">
              Generation was stopped by user.
            </p>
          </div>
        )}
      </div>

      {/* Footer with Stats (if enabled and complete) */}
      {showStats && isComplete && !error && (
        <div className="px-4 py-2 border-t border-border-subtle bg-surface-active">
          <div className="flex items-center gap-4 text-xs text-text-tertiary">
            <span>{content.length} characters</span>
            {chunkCount !== undefined && <span>{chunkCount} chunks</span>}
            {formattedDuration && <span>{formattedDuration}</span>}
          </div>
        </div>
      )}
    </div>
  );
}
