/**
 * ToolResultPartRenderer
 *
 * Renders tool execution results with success/failure indicator,
 * duration, and expandable data view.
 */

import { useState } from 'react';
import { CheckCircle2, ChevronRight, XCircle } from 'lucide-react';
import type { ToolResultPart } from '@/agents/engine/core/conversation';
import { canRenderClipAnalysisResult, ClipAnalysisResultCard } from './ClipAnalysisResultCard';

interface ToolResultPartRendererProps {
  part: ToolResultPart;
  className?: string;
}

export function ToolResultPartRenderer({ part, className = '' }: ToolResultPartRendererProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [rawOpen, setRawOpen] = useState(false);
  const hasData = part.data !== undefined || part.error !== undefined;
  const canRenderClipEvidence = canRenderClipAnalysisResult(part.tool, part.data);
  const resultSummary = summarizeToolResult(part);
  const StatusIcon = part.success ? CheckCircle2 : XCircle;

  return (
    <div className={`rounded-lg overflow-hidden ${className}`} data-testid="tool-result-part">
      <button
        onClick={hasData ? () => setIsExpanded((prev) => !prev) : undefined}
        className={`w-full flex items-center gap-2 px-3 py-1.5 text-left ${
          hasData ? 'hover:bg-surface-elevated cursor-pointer' : 'cursor-default'
        } transition-colors`}
        aria-expanded={isExpanded}
      >
        <StatusIcon
          className={`h-3.5 w-3.5 shrink-0 ${part.success ? 'text-green-400' : 'text-yellow-400'}`}
          aria-hidden="true"
        />
        <span className="text-xs font-mono text-text-secondary">{part.tool}</span>
        {resultSummary && (
          <span className="min-w-0 flex-1 truncate text-xs text-text-tertiary">
            {resultSummary}
          </span>
        )}
        <span className="text-xs text-text-tertiary ml-auto">{part.duration}ms</span>
      </button>

      {isExpanded && (
        <div className="px-3 pb-2">
          {part.error && <p className="text-xs text-red-400 mt-1">{part.error}</p>}
          {part.data !== undefined && (
            <>
              {canRenderClipEvidence && (
                <ClipAnalysisResultCard tool={part.tool} data={part.data} />
              )}
              <button
                type="button"
                onClick={() => setRawOpen((prev) => !prev)}
                className="mt-2 inline-flex items-center gap-1 rounded border border-border-subtle px-2 py-1 text-[11px] text-text-tertiary transition-colors hover:bg-surface-active hover:text-text-secondary"
                aria-expanded={rawOpen}
                data-testid="tool-result-raw-toggle"
              >
                <ChevronRight
                  className={`h-3 w-3 transition-transform ${rawOpen ? 'rotate-90' : ''}`}
                  aria-hidden="true"
                />
                Raw data
              </button>
              {rawOpen && (
                <pre className="text-xs text-text-tertiary mt-1 overflow-x-auto whitespace-pre-wrap font-mono max-h-32 overflow-y-auto">
                  {JSON.stringify(part.data, null, 2)}
                </pre>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function summarizeToolResult(part: ToolResultPart): string | null {
  if (part.error) {
    return truncate(part.error, 72);
  }

  if (typeof part.data === 'string') {
    return truncate(part.data, 72);
  }

  if (Array.isArray(part.data)) {
    return `${part.data.length} item${part.data.length === 1 ? '' : 's'}`;
  }

  if (part.data && typeof part.data === 'object') {
    const record = part.data as Record<string, unknown>;
    const status = typeof record.status === 'string' ? record.status : null;
    const message = typeof record.message === 'string' ? record.message : null;
    const summary = typeof record.summary === 'string' ? record.summary : null;
    return truncate(summary ?? message ?? status ?? 'Result available', 72);
  }

  return part.success ? 'Completed' : 'Issue reported';
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 3).trimEnd()}...` : value;
}
