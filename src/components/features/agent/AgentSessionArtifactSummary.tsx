import { useMemo } from 'react';
import type { ConversationMessage } from '@/agents/engine/core/conversation';
import { isSameArtifactFocus, type AgentArtifactFocus } from './agentArtifactFocus';
import { buildAgentArtifactSessionSummary } from './agentArtifactSummary';

interface AgentSessionArtifactSummaryProps {
  messages: readonly ConversationMessage[];
  activeArtifactFocus?: AgentArtifactFocus | null;
  onSelectArtifact?: (focus: AgentArtifactFocus) => void;
  className?: string;
}

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

export function AgentSessionArtifactSummary({
  messages,
  activeArtifactFocus = null,
  onSelectArtifact,
  className = '',
}: AgentSessionArtifactSummaryProps) {
  const summary = useMemo(() => buildAgentArtifactSessionSummary(messages), [messages]);

  const hasArtifacts = summary.toolRuns > 0 || summary.touchedFiles > 0 || summary.hasCompaction;

  if (!hasArtifacts) {
    return null;
  }

  const renderChip = (label: string, focus: AgentArtifactFocus, testId: string) => {
    const isActive = isSameArtifactFocus(activeArtifactFocus, focus);

    if (!onSelectArtifact) {
      return (
        <code
          key={testId}
          data-testid={testId}
          className="rounded bg-surface-base px-1.5 py-0.5 text-[11px] text-text-secondary"
        >
          {label}
        </code>
      );
    }

    return (
      <button
        key={testId}
        type="button"
        onClick={() => onSelectArtifact(focus)}
        data-testid={testId}
        className={`rounded px-1.5 py-0.5 text-[11px] transition-colors ${
          isActive
            ? 'bg-primary-500/15 text-primary-300 ring-1 ring-primary-500/40'
            : 'bg-surface-base text-text-secondary hover:bg-surface-active'
        }`}
      >
        {label}
      </button>
    );
  };

  return (
    <div
      className={`border-b border-border-subtle bg-surface-elevated/70 px-4 py-3 ${className}`}
      data-testid="agent-session-artifact-summary"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[10px] font-medium uppercase tracking-[0.08em] text-text-tertiary">
          Session Outputs
        </span>
        {summary.toolRuns > 0 && (
          <span className="rounded-full border border-border-subtle bg-surface-base px-2 py-0.5 text-[11px] text-text-secondary">
            {pluralize(summary.toolRuns, 'tool run')}
          </span>
        )}
        {summary.touchedFiles > 0 && (
          <span className="rounded-full border border-border-subtle bg-surface-base px-2 py-0.5 text-[11px] text-text-secondary">
            {pluralize(summary.touchedFiles, 'file')}
          </span>
        )}
        {summary.hasCompaction && (
          <button
            type="button"
            onClick={() => onSelectArtifact?.({ kind: 'summary' })}
            data-testid="artifact-summary-chip"
            className={`rounded-full border px-2 py-0.5 text-[11px] transition-colors ${
              activeArtifactFocus?.kind === 'summary'
                ? 'border-primary-500/40 bg-primary-500/15 text-primary-300'
                : 'border-border-subtle bg-surface-base text-text-secondary hover:bg-surface-active'
            } ${onSelectArtifact ? '' : 'cursor-default'}`}
            disabled={!onSelectArtifact}
          >
            summary available
          </button>
        )}
      </div>

      {summary.recentFiles.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] text-text-tertiary">Files</span>
          {summary.recentFiles.map((file) =>
            renderChip(file, { kind: 'file', value: file }, `artifact-file-${file}`),
          )}
        </div>
      )}

      {summary.recentTools.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] text-text-tertiary">Tools</span>
          {summary.recentTools.map((tool) =>
            renderChip(tool, { kind: 'tool', value: tool }, `artifact-tool-${tool}`),
          )}
        </div>
      )}
    </div>
  );
}
